import {
  consumeStream,
  convertToModelMessages,
  pruneMessages
} from 'ai'
import { randomUUID } from 'crypto'
import { Langfuse } from 'langfuse'

import { researcher } from '@/lib/agents/researcher'
import {
  createPublicErrorResponse,
  serializePublicError
} from '@/lib/errors/public-error'
import { isTracingEnabled } from '@/lib/utils/telemetry'

import { loadChat } from '../actions/chat'
import { generateChatTitle } from '../agents/title-generator'
import {
  getMaxAllowedTokens,
  shouldTruncateMessages,
  truncateMessages
} from '../utils/context-window'
import { getTextFromParts } from '../utils/message-utils'
import { perfLog, perfTime } from '../utils/perf-logging'
import { isUsageLogging, logUsage } from '../utils/usage-logging'

import { convertDataPart } from './helpers/convert-data-part'
import { persistStreamResults } from './helpers/persist-stream-results'
import { prepareMessages } from './helpers/prepare-messages'
import { stripNarrationFromMessage } from './helpers/strip-narration-from-message'
import { stripNarrationPreamble } from './helpers/strip-narration-preamble'
import { stripReasoningParts } from './helpers/strip-reasoning-parts'
import { stripSpecFromMessages } from './helpers/strip-spec-from-messages'
import { transformFileParts } from './helpers/transform-file-parts'
import type { StreamContext } from './helpers/types'
import { BaseStreamConfig } from './types'

// Constants
const DEFAULT_CHAT_TITLE = 'Untitled'

/**
 * A `StreamTextTransform` factory that does two things on every text
 * part emitted by the agent:
 *
 * 1. Strip narration: while we're still in the leading narration (we
 *    haven't seen the first `## ` heading yet in the accumulated text),
 *    we hold text-delta chunks back. The moment the buffer crosses the
 *    `## ` boundary, we emit only the post-`## ` portion of the buffer
 *    and pass all subsequent text-delta chunks through unchanged. If
 *    the stream ends without ever producing a `## ` (refusals, short
 *    factual answers), we flush the entire buffer on text-end so the
 *    response is never lost.
 *
 * 2. Coalesce buffer: we don't add an artificial inter-chunk delay
 *    (so the UI feels snappy), but we DO buffer the leading narration
 *    silently, so the user only ever sees the post-`## ` text appear.
 *    After the heading, chunks stream through verbatim.
 */
function smoothAndStripNarration() {
  return (_options: { tools: any; stopStream: () => void }) => {
    let buffer = ''
    let currentTextId: string | undefined
    let narrationMode = true

    return new TransformStream({
      transform(chunk: any, controller: TransformStreamDefaultController) {
        if (chunk.type === 'text-start') {
          // Begin a new text part. Reset buffers.
          buffer = ''
          currentTextId = chunk.id
          narrationMode = true
          controller.enqueue(chunk)
          return
        }

        if (chunk.type === 'text-delta') {
          if (narrationMode) {
            buffer += chunk.text
            const cleaned = stripNarrationPreamble(buffer)
            if (cleaned === buffer) {
              // Still in narration; hold the chunk back.
              return
            }
            // We crossed the heading. Emit text-start (already done above)
            // plus a single text-delta with only the post-## content.
            narrationMode = false
            controller.enqueue({ ...chunk, text: cleaned })
            return
          }
          // After narration, pass through.
          controller.enqueue(chunk)
          return
        }

        if (chunk.type === 'text-end') {
          if (narrationMode && buffer) {
            // Stream ended without a `## ` heading — emit the full
            // buffer so we never drop a refusal or short answer.
            controller.enqueue({ ...chunk, text: buffer })
            narrationMode = false
          }
          controller.enqueue(chunk)
          buffer = ''
          return
        }

        // Pass through reasoning, tool, finish, start, etc. unchanged.
        controller.enqueue(chunk)
      }
    })
  }
}

export async function createChatStreamResponse(
  config: BaseStreamConfig
): Promise<Response> {
  const {
    message,
    model,
    chatId,
    userId,
    trigger,
    messageId,
    abortSignal,
    isNewChat,
    searchMode,
    sources,
    systemInstructions
  } = config

  // Verify that chatId is provided
  if (!chatId) {
    return new Response('Chat ID is required', {
      status: 400,
      statusText: 'Bad Request'
    })
  }

  // Skip loading chat for new chats optimization
  let initialChat = null
  if (!isNewChat) {
    const loadChatStart = performance.now()
    // Fetch chat data for authorization check and cache it
    initialChat = await loadChat(chatId, userId)
    perfTime('loadChat completed', loadChatStart)

    // Authorization check: if chat exists, it must belong to the user
    if (initialChat && initialChat.userId !== userId) {
      return new Response('You are not allowed to access this chat', {
        status: 403,
        statusText: 'Forbidden'
      })
    }
  } else {
    perfLog('loadChat skipped for new chat')
  }

  // Create parent trace ID for grouping all operations
  let parentTraceId: string | undefined
  let langfuse: Langfuse | undefined

  if (isTracingEnabled()) {
    parentTraceId = randomUUID()
    langfuse = new Langfuse()

    // Create parent trace with name "research"
    langfuse.trace({
      id: parentTraceId,
      name: 'research',
      metadata: {
        chatId,
        userId,
        modelId: `${model.providerId}:${model.id}`,
        trigger
      }
    })
  }

  // Create stream context with trace ID
  const context: StreamContext = {
    chatId,
    userId,
    modelId: `${model.providerId}:${model.id}`,
    messageId,
    trigger,
    initialChat,
    abortSignal,
    parentTraceId,
    isNewChat
  }

  // Declare titlePromise in outer scope for onFinish access
  let titlePromise: Promise<string> | undefined

  try {
    // Prepare messages for the model
    const prepareStart = performance.now()
    perfLog(
      `prepareMessages - Invoked: trigger=${trigger}, isNewChat=${isNewChat}`
    )
    const messagesToModel = await prepareMessages(context, message)
    perfTime('prepareMessages completed (stream)', prepareStart)

    // Get the researcher agent with parent trace ID, search mode, and sources.
    const researchAgent = researcher({
      model: context.modelId,
      modelConfig: model,
      parentTraceId,
      searchMode,
      sources,
      systemInstructions
    })

    // For OpenAI models, strip reasoning parts from UIMessages before conversion
    // OpenAI's Responses API requires reasoning items and their following items to be kept together
    // See: https://github.com/vercel/ai/issues/11036
    const isOpenAI = context.modelId.startsWith('openai:')
    const messagesWithoutSpec = stripSpecFromMessages(messagesToModel)
    const messagesToConvert = isOpenAI
      ? stripReasoningParts(messagesWithoutSpec)
      : messagesWithoutSpec

    // Transform file parts before the model sees them:
    // PDFs → pdftotext extracted text (or rendered page images for scanned PDFs)
    // Image URLs → base64 data URIs (avoids the model fetching from our upload URL)
    const messagesForModel = await transformFileParts(messagesToConvert)

    // Convert to model messages and apply context window management
    let modelMessages = await convertToModelMessages(messagesForModel, {
      convertDataPart
    })

    // Prune messages to reduce token usage while keeping recent context
    modelMessages = pruneMessages({
      messages: modelMessages,
      reasoning: 'before-last-message',
      toolCalls: 'before-last-2-messages',
      emptyMessages: 'remove'
    })

    if (shouldTruncateMessages(modelMessages, model)) {
      const maxTokens = getMaxAllowedTokens(model)
      const originalCount = modelMessages.length
      modelMessages = truncateMessages(modelMessages, maxTokens, model.id)

      if (process.env.NODE_ENV === 'development') {
        console.log(
          `Context window limit reached. Truncating from ${originalCount} to ${modelMessages.length} messages`
        )
      }
    }

    // Start title generation in parallel if it's a new chat
    if (!initialChat && message) {
      const userContent = getTextFromParts(message.parts)
      titlePromise = generateChatTitle({
        userMessageContent: userContent,
        modelId: context.modelId,
        abortSignal,
        parentTraceId
      }).catch(error => {
        console.error('Error generating title:', error)
        return DEFAULT_CHAT_TITLE
      })
    }

    const llmStart = performance.now()
    perfLog(
      `researchAgent.stream - Start: model=${context.modelId}, searchMode=${searchMode}`
    )
    const result = await researchAgent.stream({
      messages: modelMessages,
      abortSignal,
      experimental_transform: smoothAndStripNarration(),
      ...(isUsageLogging() && {
        onStepFinish: step => {
          logUsage(
            { scope: 'step', modelId: context.modelId },
            step.usage,
            step.providerMetadata
          )
        }
      })
    })
    result.consumeStream()

    // Log the session-total usage once the stream settles (does not block the
    // response; consumeStream above already drives it to completion).
    if (isUsageLogging()) {
      Promise.resolve(result.totalUsage)
        .then(usage =>
          logUsage({ scope: 'total', modelId: context.modelId }, usage)
        )
        .catch(() => {})
    }

    return result.toUIMessageStreamResponse({
      messageMetadata: ({ part }) => {
        if (part.type === 'start') {
          return {
            traceId: parentTraceId,
            searchMode,
            modelId: context.modelId
          }
        }
      },
      onFinish: async ({ responseMessage, isAborted }) => {
        try {
          perfTime('researchAgent.stream completed', llmStart)
          if (isAborted || !responseMessage) return

          // Clean the assembled responseMessage of any narration preamble
          // before persistence. The stream transform already filters
          // outgoing text-delta, but if the stream was interrupted or the
          // transform state got out of sync, the assembled message may
          // still contain the leading narration. Strip it here so the
          // DB row is clean even on a partial response.
          const cleanedMessage = stripNarrationFromMessage(responseMessage)

          // Persist stream results to database
          await persistStreamResults(
            cleanedMessage,
            chatId,
            userId,
            titlePromise,
            parentTraceId,
            searchMode,
            context.modelId,
            context.pendingInitialSave,
            context.pendingInitialUserMessage
          )
        } finally {
          if (langfuse) {
            await langfuse.flushAsync()
          }
        }
      },
      onError: (error: unknown) => {
        console.error('Stream response error:', error)
        return serializePublicError(error)
      },
      consumeSseStream: consumeStream
    })
  } catch (error) {
    if (langfuse) {
      await langfuse.flushAsync()
    }
    console.error('Stream execution error:', error)
    return createPublicErrorResponse(error, {
      status: 500,
      statusText: 'Internal Server Error'
    })
  }
}
