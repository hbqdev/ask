import { ModelMessage } from 'ai'
import { getEncoding, type TiktokenEncoding } from 'js-tiktoken'

import { Model } from '../types/models'

interface ModelContextInfo {
  contextWindow: number
  outputTokens: number
}

// Model-specific context window configurations
const MODEL_CONTEXT_WINDOWS: Record<string, ModelContextInfo> = {
  // OpenAI Models
  'gpt-4.1': { contextWindow: 128000, outputTokens: 16384 },
  'gpt-4.1-mini': { contextWindow: 128000, outputTokens: 16384 },
  'gpt-4.1-nano': { contextWindow: 128000, outputTokens: 16384 },
  'gpt-4o-mini': { contextWindow: 128000, outputTokens: 16384 },

  // Anthropic Models
  'claude-opus-4': { contextWindow: 680000, outputTokens: 8192 },
  'claude-sonnet-4': { contextWindow: 680000, outputTokens: 8192 },
  'claude-3-7-sonnet': { contextWindow: 200000, outputTokens: 8192 },
  'claude-3-7-sonnet-20250219': { contextWindow: 200000, outputTokens: 8192 },
  'claude-3-5-haiku-20241022': { contextWindow: 200000, outputTokens: 8192 },

  // Google Models
  'gemini-3-flash-preview': { contextWindow: 1048576, outputTokens: 65536 },
  'gemini-3.1-flash-lite': { contextWindow: 1048576, outputTokens: 65536 },
  'gemini-2.5-flash': { contextWindow: 1048576, outputTokens: 65536 },
  'gemini-2.5-pro': { contextWindow: 1048576, outputTokens: 65536 },

  // xAI Models
  'grok-4-0709': { contextWindow: 256000, outputTokens: 8192 },
  'grok-3': { contextWindow: 131072, outputTokens: 8192 },
  'grok-3-mini': { contextWindow: 131072, outputTokens: 8192 }
}

// Output tokens to reserve when the window came from a probe rather than the
// static map. Generation shares the context window, so some room has to be
// held back or long answers get cut off mid-sentence. Measured completions on
// this deployment run 1.7k-3.2k tokens, so this is generous.
const PROBED_OUTPUT_RESERVE = 8192

// Safety buffer percentage (reserved for system prompts and formatting).
// Also absorbs tokenizer drift: we estimate with cl100k for every model,
// which is only an approximation for non-OpenAI tokenizers.
const SAFETY_BUFFER_RATIO = 0.1

// Cache for tiktoken encoders
const encoderCache = new Map<string, any>()

// Mapping of our model IDs to tiktoken encoding names
// js-tiktoken supports 'cl100k_base' (for GPT-4), 'p50k_base', 'r50k_base'
const MODEL_TO_ENCODING: Record<string, TiktokenEncoding> = {
  'gpt-4.1': 'cl100k_base',
  'gpt-4.1-mini': 'cl100k_base',
  'gpt-4.1-nano': 'cl100k_base',
  'gpt-4o-mini': 'cl100k_base',
  'claude-opus-4': 'cl100k_base', // Use GPT-4 tokenizer as approximation for Claude
  'claude-sonnet-4': 'cl100k_base',
  'claude-3-7-sonnet': 'cl100k_base',
  'claude-3-7-sonnet-20250219': 'cl100k_base',
  'claude-3-5-haiku-20241022': 'cl100k_base',
  'gemini-3-flash-preview': 'cl100k_base', // Use GPT-4 tokenizer as approximation for Gemini
  'gemini-3.1-flash-lite': 'cl100k_base',
  'gemini-2.5-flash': 'cl100k_base',
  'gemini-2.5-pro': 'cl100k_base',
  'grok-4-0709': 'cl100k_base', // Use GPT-4 tokenizer as approximation for Grok
  'grok-3': 'cl100k_base',
  'grok-3-mini': 'cl100k_base'
}

/**
 * Get model-specific context window information, or null when this model is
 * not in the static map. Callers must treat null as "unknown" — there is
 * deliberately no default, because the previous 16384 fallback applied to
 * every Ollama model we run and silently truncated their history.
 */
function getModelContextInfo(modelId: string): ModelContextInfo | null {
  return MODEL_CONTEXT_WINDOWS[modelId] ?? null
}

/**
 * The statically-known context window for a model id, or null. Exported for
 * resolve-context-window.ts, which falls back to probing the provider.
 */
export function getStaticContextWindow(modelId: string): number | null {
  return getModelContextInfo(modelId)?.contextWindow ?? null
}

/**
 * Maximum input tokens for a model, or null when the window is unknown and
 * nothing should be truncated.
 *
 * `contextWindow` overrides the static map — pass the value resolved from the
 * provider (see resolveContextWindow) so we size against the model's real
 * window rather than a hardcoded guess.
 */
export function getMaxAllowedTokens(
  model: Model,
  contextWindow?: number | null
): number | null {
  const staticInfo = getModelContextInfo(model.id)
  const window = contextWindow ?? staticInfo?.contextWindow ?? null
  if (window === null) return null

  // A probed window has no separate output budget — generation shares it.
  const outputTokens =
    contextWindow != null && contextWindow !== staticInfo?.contextWindow
      ? PROBED_OUTPUT_RESERVE
      : (staticInfo?.outputTokens ?? PROBED_OUTPUT_RESERVE)

  const safetyBuffer = Math.floor(window * SAFETY_BUFFER_RATIO)
  return Math.max(window - outputTokens - safetyBuffer, 1000)
}

/**
 * Extract text content from various message content types
 */
function extractTextContent(content: ModelMessage['content']): string {
  if (!content) return ''

  // Handle string content
  if (typeof content === 'string') {
    return content
  }

  // Handle array of parts
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if ('text' in part) {
          return part.text
        }
        return ''
      })
      .join(' ')
  }

  // Handle other content types
  return ''
}

/**
 * Get or create encoder for a model
 */
function getEncoder(modelId: string) {
  try {
    const encodingName: TiktokenEncoding =
      MODEL_TO_ENCODING[modelId] || 'cl100k_base'

    if (!encoderCache.has(encodingName)) {
      const encoder = getEncoding(encodingName)
      encoderCache.set(encodingName, encoder)
    }

    return encoderCache.get(encodingName)
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn(
        `Failed to load tokenizer for model ${modelId}, falling back to estimation`,
        error
      )
    }
    return null
  }
}

/**
 * Estimate token count for a message
 * Uses tiktoken for accurate counting when available
 */
function estimateTokenCount(
  content: ModelMessage['content'],
  modelId?: string
): number {
  const text = extractTextContent(content)
  if (!text) return 0

  // Try to use tiktoken for accurate counting
  if (modelId) {
    const encoder = getEncoder(modelId)
    if (encoder) {
      try {
        const tokens = encoder.encode(text)
        const tokenCount = tokens.length
        const overhead = 4 // Message formatting tokens
        return tokenCount + overhead
      } catch (error) {
        if (process.env.NODE_ENV === 'development') {
          console.warn(
            'Failed to encode text with tiktoken, falling back to estimation',
            error
          )
        }
      }
    }
  }

  // Fallback: Rough approximation
  // ~4 characters per token for English, adjust for other languages
  const baseCount = Math.ceil(text.length / 4)
  const overhead = 4 // Message formatting tokens

  return baseCount + overhead
}

/**
 * Smart message truncation with priority for context preservation
 */
export function truncateMessages(
  messages: ModelMessage[],
  maxTokens: number,
  modelId?: string
): ModelMessage[] {
  // Input validation
  if (!messages || messages.length === 0) return []
  if (maxTokens <= 0) {
    console.error('Invalid maxTokens value:', maxTokens)
    return []
  }

  // Always try to keep the first user message (initial context)
  const firstUserIndex = messages.findIndex(m => m.role === 'user')
  const firstUserMessage = firstUserIndex >= 0 ? messages[firstUserIndex] : null

  // Calculate token counts for all messages
  const messageTokenCounts = messages.map(msg => ({
    message: msg,
    tokens: estimateTokenCount(msg.content, modelId)
  }))

  // Calculate total tokens
  const totalTokens = messageTokenCounts.reduce(
    (sum, item) => sum + item.tokens,
    0
  )

  // If under limit, return all messages
  if (totalTokens <= maxTokens) {
    return messages
  }

  // Strategy: Keep first user message + as many recent messages as possible
  const result: ModelMessage[] = []
  let usedTokens = 0

  // Reserve space for first user message if it exists
  if (firstUserMessage) {
    const firstUserTokens = estimateTokenCount(
      firstUserMessage.content,
      modelId
    )
    if (firstUserTokens < maxTokens * 0.3) {
      // Don't let first message take more than 30%
      result.push(firstUserMessage)
      usedTokens += firstUserTokens
    }
  }

  // Add recent messages from the end
  const recentMessages: ModelMessage[] = []

  for (let i = messages.length - 1; i >= 0; i--) {
    const { message, tokens } = messageTokenCounts[i]

    // Skip if this is the first user message (already added)
    if (firstUserMessage && i === firstUserIndex) continue

    if (usedTokens + tokens <= maxTokens) {
      recentMessages.unshift(message)
      usedTokens += tokens
    } else {
      // Try to at least include the last user message if we haven't
      if (message.role === 'user' && recentMessages.length > 0) {
        // Remove oldest assistant messages to make room
        while (recentMessages.length > 0 && usedTokens + tokens > maxTokens) {
          const removed = recentMessages.shift()
          if (removed) {
            usedTokens -= estimateTokenCount(removed.content, modelId)
          }
        }
        if (usedTokens + tokens <= maxTokens) {
          recentMessages.unshift(message)
          usedTokens += tokens
        }
      }
      break
    }
  }

  // Combine results, ensuring conversation flow
  if (firstUserMessage && result.length > 0) {
    // If we kept the first message, add recent ones
    result.push(...recentMessages)
  } else {
    // Otherwise, just use recent messages
    result.push(...recentMessages)
  }

  // Ensure the result starts with a user message
  while (result.length > 0 && result[0].role !== 'user') {
    result.shift()
  }

  // The message being answered must survive. Two boundary paths above could
  // drop it, and both are worse than any amount of lost history:
  //
  //   1. A single user message larger than maxTokens. It fails the 30% reserve
  //      (`firstUserTokens < maxTokens * 0.3`) so it is never added, and the
  //      reverse loop `continue`s past it because i === firstUserIndex. The
  //      function returned [] and the turn called stream({ messages: [] }).
  //   2. [user('a'), assistant, user(oversized)]. 'a' takes the reserve, the
  //      newest message does not fit, and the recovery branch requires
  //      recentMessages.length > 0 — which is false — so it breaks. The result
  //      was exactly [user('a')]: the model answers the FIRST question and
  //      never sees the one just asked.
  //
  // Reachable in practice: transform-file-parts inlines whole pdftotext output
  // into the user message with no size cap, and shouldTruncateMessages only
  // guards the unknown-window case, not "one message exceeds the window".
  const lastUserIndex = messages.map(m => m.role).lastIndexOf('user')
  if (lastUserIndex >= 0) {
    const lastUser = messages[lastUserIndex]
    if (!result.includes(lastUser)) {
      // Prefer dropping older context over dropping the live question.
      const lastUserTokens = estimateTokenCount(lastUser.content, modelId)
      let budget = maxTokens - lastUserTokens
      while (budget < 0 && result.length > 0) {
        const dropped = result.shift()
        if (dropped) budget += estimateTokenCount(dropped.content, modelId)
      }
      result.push(lastUser)
      while (result.length > 0 && result[0].role !== 'user') {
        result.shift()
      }
    }
  }

  return result
}

/**
 * Check if messages need truncation
 */
export function shouldTruncateMessages(
  messages: ModelMessage[],
  model: Model,
  contextWindow?: number | null
): boolean {
  if (!messages || messages.length === 0) return false

  const maxTokens = getMaxAllowedTokens(model, contextWindow)
  // Unknown window: never truncate. Dropping history to fit an invented
  // limit loses the user's conversation for no reason.
  if (maxTokens === null) return false

  const totalTokens = messages.reduce(
    (sum, msg) => sum + estimateTokenCount(msg.content, model.id),
    0
  )
  return totalTokens > maxTokens
}
