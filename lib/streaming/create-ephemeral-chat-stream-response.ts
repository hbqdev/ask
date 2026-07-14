import type { UIMessage } from 'ai'
import {
  consumeStream,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  pruneMessages,
  smoothStream
} from 'ai'
import { randomUUID } from 'crypto'
import { Langfuse } from 'langfuse'

import { researcher } from '@/lib/agents/researcher'
import {
  createPublicErrorResponse,
  serializePublicError
} from '@/lib/errors/public-error'
import { isTracingEnabled } from '@/lib/utils/telemetry'

import { classifyQuery } from '../agents/query-classifier'
import { expandQuery } from '../agents/query-expander'
import {
  getMaxAllowedTokens,
  shouldTruncateMessages,
  truncateMessages
} from '../utils/context-window'
import { getTextFromParts } from '../utils/message-utils'
import { isUsageLogging, logUsage } from '../utils/usage-logging'

import { convertDataPart } from './helpers/convert-data-part'
import { stripReasoningParts } from './helpers/strip-reasoning-parts'
import { stripSpecFromMessages } from './helpers/strip-spec-from-messages'
import { BaseStreamConfig } from './types'

type EphemeralStreamConfig = Pick<
  BaseStreamConfig,
  'model' | 'abortSignal' | 'searchMode' | 'sources'
> & {
  messages: UIMessage[]
  chatId?: string
}

export async function createEphemeralChatStreamResponse(
  config: EphemeralStreamConfig
): Promise<Response> {
  const { messages, model, abortSignal, searchMode, sources, chatId } = config

  if (!messages || messages.length === 0) {
    return new Response('messages are required', {
      status: 400,
      statusText: 'Bad Request'
    })
  }

  // Create parent trace ID for grouping all operations
  let parentTraceId: string | undefined
  let langfuse: Langfuse | undefined

  if (isTracingEnabled()) {
    parentTraceId = randomUUID()
    langfuse = new Langfuse()

    langfuse.trace({
      id: parentTraceId,
      name: 'research',
      metadata: {
        chatId,
        userId: 'guest',
        modelId: `${model.providerId}:${model.id}`,
        trigger: 'submit-message'
      }
    })
  }

  try {
    // See create-chat-stream-response.ts for the reasoning behind this —
    // kicked off in parallel with message-prep below, awaited just before
    // constructing the researcher agent, with the wait surfaced to the
    // client as a data-classifier step. (No regenerate bypass here:
    // ephemeral chats have no Retry trigger.)
    const latestMessage = messages[messages.length - 1]
    const latestMessageText = getTextFromParts(latestMessage?.parts)
    const containsUrl = /https?:\/\/\S+/i.test(latestMessageText)
    const classifyStart = performance.now()
    const classificationPromise = containsUrl
      ? Promise.resolve({
          skipSearch: false,
          standaloneQuery: latestMessageText,
          needsRecent: false
        })
      : classifyQuery({ messages, abortSignal })

    const modelId = `${model.providerId}:${model.id}`

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({
          type: 'start',
          messageMetadata: {
            traceId: parentTraceId,
            searchMode,
            modelId
          }
        })

        if (!containsUrl) {
          writer.write({
            type: 'data-classifier',
            id: 'classifier',
            data: { state: 'running' }
          })
        }

        const isOpenAI = modelId.startsWith('openai:')
        const messagesWithoutSpec = stripSpecFromMessages(messages)
        const messagesToConvert = isOpenAI
          ? stripReasoningParts(messagesWithoutSpec)
          : messagesWithoutSpec

        let modelMessages = await convertToModelMessages(messagesToConvert, {
          convertDataPart
        })

        modelMessages = pruneMessages({
          messages: modelMessages,
          reasoning: 'before-last-message',
          toolCalls: 'before-last-2-messages',
          emptyMessages: 'remove'
        })

        if (shouldTruncateMessages(modelMessages, model)) {
          const maxTokens = getMaxAllowedTokens(model)
          modelMessages = truncateMessages(modelMessages, maxTokens, model.id)
        }

        const classification = await classificationPromise

        // Query expansion (lib/agents/query-expander.ts) starts as soon as
        // the resolved standalone query exists and overlaps with agent
        // construction — the first search of the turn awaits it (bounded)
        // and fans out to the variants. Speed mode and skipped turns stay
        // single-query.
        const expandedQueriesPromise =
          !classification.skipSearch && searchMode !== 'speed'
            ? expandQuery({
                standaloneQuery: classification.standaloneQuery,
                abortSignal
              })
            : Promise.resolve([])

        if (!containsUrl) {
          // Same part id — replaces the 'running' entry in place.
          writer.write({
            type: 'data-classifier',
            id: 'classifier',
            data: {
              state: 'done',
              skipSearch: classification.skipSearch,
              standaloneQuery: classification.standaloneQuery,
              durationMs: Math.round(performance.now() - classifyStart)
            }
          })
        }

        const researchAgent = researcher({
          model: modelId,
          modelConfig: model,
          parentTraceId,
          searchMode,
          sources,
          abortSignal,
          skipSearch: classification.skipSearch,
          standaloneQuery: classification.standaloneQuery,
          needsRecent: classification.needsRecent,
          expandedQueriesPromise
        })

        const result = await researchAgent.stream({
          messages: modelMessages,
          abortSignal,
          experimental_transform: smoothStream({ chunking: 'word' }),
          ...(isUsageLogging() && {
            onStepFinish: step => {
              logUsage(
                { scope: 'step', modelId },
                step.usage,
                step.providerMetadata
              )
            }
          })
        })
        result.consumeStream()

        if (isUsageLogging()) {
          Promise.resolve(result.totalUsage)
            .then(usage => logUsage({ scope: 'total', modelId }, usage))
            .catch(() => {})
        }

        writer.merge(result.toUIMessageStream({ sendStart: false }))
      },
      onFinish: async () => {
        if (langfuse) {
          await langfuse.flushAsync()
        }
      },
      onError: (error: unknown) => {
        console.error('Ephemeral stream response error:', error)
        return serializePublicError(error)
      }
    })

    return createUIMessageStreamResponse({
      stream,
      consumeSseStream: consumeStream
    })
  } catch (error) {
    if (langfuse) {
      await langfuse.flushAsync()
    }
    console.error('Ephemeral stream execution error:', error)
    return createPublicErrorResponse(error, {
      status: 500,
      statusText: 'Internal Server Error'
    })
  }
}
