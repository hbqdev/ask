import { generateText } from 'ai'
import { createOllama } from 'ai-sdk-ollama'

import { createTimeoutFetch } from '../utils/fetch-with-timeout'
import { localLlmBaseUrl } from '../utils/local-llm-host'
import { getModel } from '../utils/registry'
import { isTracingEnabled } from '../utils/telemetry'

/**
 * Titles are written by a LOCAL model, not the user's chat model.
 *
 * WHY. Titling is a 3-5 word transformation of one sentence, and it was
 * spending a frontier cloud call on every new chat: 523 chats in one week, so
 * 523 billed kimi-k2.6 requests whose entire output was a sidebar label. That
 * was ~13% of the week's kimi volume, for the least demanding task in the app.
 *
 * granite4.1:8b on the local host is already resident for the memory extractor
 * and pinned warm by keep-warm.sh, so this costs nothing and adds no cold
 * start. If the local host is unreachable the catch below returns the user's
 * own opening words — the same fallback that already covered a cloud failure,
 * so the downside of a miss is a duller title, never a broken chat.
 *
 * TITLE_MODEL_ID overrides the model; TITLE_USE_CHAT_MODEL=true restores the
 * old behaviour without a redeploy, for the case where a local host does not
 * exist at all.
 */
// Read per call, not at module load. A module-level `process.env` read freezes
// the value at import, which would have made the override above a lie: it
// promises a change without a redeploy and a frozen constant cannot deliver
// one. Costs nothing — this runs once per new chat.
function titleModelId(): string {
  return process.env.TITLE_MODEL_ID || 'granite4.1:8b'
}
// Titling one sentence is fast; a local model that has not answered in 8s is
// not going to produce a better title than the user's own words.
const TITLE_TIMEOUT_MS = 8_000

/**
 * A generated title is meant to be 3-5 words ("no more than 10"). Anything
 * dramatically longer is not a long title — it means the model ignored the
 * instruction and ANSWERED the user's first message instead of titling it,
 * because that message is handed to it verbatim as the prompt and usually
 * IS a question. Observed in production: four chats whose titles were entire
 * answers, the longest 4,832 characters, rendering into the sidebar, the
 * library, and recall's attribution chips.
 */
const MAX_TITLE_LENGTH = 100

interface GenerateChatTitleParams {
  userMessageContent: string
  modelId: string
  abortSignal?: AbortSignal
  parentTraceId?: string
}

/**
 * Generates a concise chat title using an LLM.
 * @param userMessageContent The content of the user's first message.
 * @param model The language model instance to use for generation.
 * @returns A promise that resolves to the generated title string.
 */
export async function generateChatTitle({
  userMessageContent,
  modelId,
  abortSignal,
  parentTraceId
}: GenerateChatTitleParams): Promise<string> {
  // Fallback title uses the first 75 characters of the message or a default string.
  const fallbackTitle = userMessageContent.substring(0, 75).trim() || 'New Chat'

  try {
    const systemPrompt = `System: You are an AI assistant specialized in creating very short, concise, and informative titles for chat conversations based on the user's first message. The title should ideally be 3-5 words long, and no more than 10 words. Only output the title itself, with no prefixes, labels, or quotation marks.`

    // Local when a local host is configured, otherwise the chat model — a
    // deployment with no local Ollama must not lose titles entirely.
    const localBase = localLlmBaseUrl()
    const useLocal =
      Boolean(localBase) && process.env.TITLE_USE_CHAT_MODEL !== 'true'
    const titleModel = useLocal
      ? createOllama({
          baseURL: localBase,
          fetch: createTimeoutFetch(TITLE_TIMEOUT_MS, abortSignal)
        })(titleModelId(), { think: false, keep_alive: -1 })
      : getModel(modelId)
    const effectiveModelId = useLocal ? titleModelId() : modelId

    const { text: generatedTitle } = await generateText({
      model: titleModel,
      system: systemPrompt,
      prompt: userMessageContent,
      abortSignal,
      experimental_telemetry: {
        isEnabled: isTracingEnabled(),
        functionId: 'title-generation',
        metadata: {
          modelId: effectiveModelId,
          agentType: 'title-generator',
          promptLength: userMessageContent.length,
          ...(parentTraceId && {
            langfuseTraceId: parentTraceId,
            langfuseUpdateParent: false
          })
        }
      }
    })

    // Take the first non-empty line: a model that emits a real title and then
    // keeps talking ("Firecrawl Alternatives\n\nHere's why...") still gave us
    // a usable title on line one.
    const cleanedTitle =
      generatedTitle
        .split('\n')
        .map(line => line.trim())
        .find(line => line.length > 0) ?? ''

    // If the model returns an empty string, use the fallback.
    if (!cleanedTitle) {
      console.warn('LLM generated an empty title, using fallback.')
      return fallbackTitle
    }

    // Remove any surrounding quotes that the model might have added
    const unquoted = cleanedTitle.replace(/^["']|["']$/g, '').trim()

    // The model answered instead of titling. Do NOT truncate that answer into
    // a "title" — the first 100 characters of prose is not a title either.
    // The deterministic fallback (the user's own opening words) is a genuinely
    // better title than any slice of a runaway answer.
    if (unquoted.length > MAX_TITLE_LENGTH) {
      console.warn(
        `[title] model returned ${unquoted.length} chars (max ${MAX_TITLE_LENGTH}) — it answered instead of titling; using fallback.`
      )
      return fallbackTitle
    }

    return unquoted || fallbackTitle
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'ResponseAborted')
    ) {
      if (process.env.NODE_ENV === 'development') {
        console.info('Title generation aborted; using fallback title.')
      }
    } else {
      console.error('Error generating chat title with LLM:', error)
    }
    // If LLM generation fails or is aborted, return the fallback title.
    return fallbackTitle
  }
}
