import {
  consumeStream,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  pruneMessages
} from 'ai'
import { randomUUID } from 'crypto'
import { Langfuse } from 'langfuse'

import { researcher } from '@/lib/agents/researcher'
import { modelSupportsVision } from '@/lib/config/model-vision'
import {
  createPublicErrorResponse,
  serializePublicError
} from '@/lib/errors/public-error'
import { isTracingEnabled } from '@/lib/utils/telemetry'

import { loadChatUncached } from '../actions/chat'
import { extractMemories } from '../agents/memory-extractor'
import { classifyQuery } from '../agents/query-classifier'
import { expandQuery } from '../agents/query-expander'
import { generateChatTitle } from '../agents/title-generator'
import { isMemoryEnabled } from '../db/memory-actions'
import { extractIndexableText } from '../memory/extract-indexable-text'
import { indexMessage } from '../memory/recall-index'
import { getRecallInjection } from '../memory/recall-inject'
import { saveCandidates } from '../memory/write'
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
import { smoothAndStripNarration } from './helpers/smooth-and-strip-narration'
import { stripNarrationFromMessage } from './helpers/strip-narration-from-message'
import { stripReasoningParts } from './helpers/strip-reasoning-parts'
import { stripSpecFromMessages } from './helpers/strip-spec-from-messages'
import { transformFileParts } from './helpers/transform-file-parts'
import type { StreamContext } from './helpers/types'
import { BaseStreamConfig } from './types'

// Constants
const DEFAULT_CHAT_TITLE = 'Untitled'

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
    initialChat = await loadChatUncached(chatId, userId)
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

    // Decide whether this turn needs new research or is answerable directly
    // from the existing conversation (see query-classifier.ts). Kicked off
    // here, in parallel with the message-prep pipeline below, and awaited
    // just before constructing the researcher agent — the classifier call
    // (local, ~1-8s) overlaps with that work instead of adding pure latency.
    // Bypassed (always search) in two unambiguous cases not worth a
    // classifier call:
    // - the message contains a URL: the search-mode prompts already say to
    //   fetch it directly;
    // - the user hit Retry (regenerate): the classifier is deterministic
    //   (temperature 0), so re-classifying would reproduce a wrong skip
    //   verbatim — treating Retry as "do it properly, with research" gives
    //   the user a built-in override for misclassified turns.
    const latestMessageForModel = messagesToModel[messagesToModel.length - 1]
    const latestMessageText = getTextFromParts(latestMessageForModel?.parts)
    const containsUrl = /https?:\/\/\S+/i.test(latestMessageText)
    const isRegenerate = trigger?.startsWith('regenerate') ?? false
    const bypassClassifier = containsUrl || isRegenerate
    const classifyStart = performance.now()
    const classificationPromise = bypassClassifier
      ? Promise.resolve({
          skipSearch: false,
          standaloneQuery: latestMessageText,
          needsRecent: false,
          intent: 'general' as const
        })
      : classifyQuery({ messages: messagesToModel, abortSignal })

    // Declared in outer scope (same pattern as titlePromise above) so the
    // memory-extraction block in onFinish — a sibling property of execute on
    // the createUIMessageStream object, not nested inside it — can read the
    // resolved standaloneQuery hint.
    let classification: Awaited<typeof classificationPromise> | undefined

    // Everything from here runs inside the UI message stream so the client
    // gets a live response immediately — most importantly, the classifier
    // wait is surfaced as a visible step (data-classifier part) instead of
    // dead air before the first byte.
    let llmStart = performance.now()

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Emit the message start ourselves (with the metadata the old
        // messageMetadata callback attached on 'start') so the classifier
        // step can stream before the researcher run begins. The merged
        // agent stream below uses sendStart: false to avoid a duplicate.
        writer.write({
          type: 'start',
          messageMetadata: {
            traceId: parentTraceId,
            searchMode,
            modelId: context.modelId
          }
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
        // PDFs → RAG excerpts or pdftotext extracted text
        // Image URLs → base64 data URIs (avoids the model fetching from our upload URL)
        // This re-runs for every user message with attachments on every
        // turn (RAG queries, subprocess extraction, file reads), so surface
        // it as its own step — otherwise an attachment-heavy chat gets
        // seconds of unexplained silence before anything appears.
        const attachmentCount = messagesToConvert
          .filter(m => m.role === 'user')
          .flatMap(m => m.parts ?? [])
          .filter(p => p.type === 'file').length
        const attachmentsStart = performance.now()
        if (attachmentCount > 0) {
          writer.write({
            type: 'data-attachments',
            id: 'attachments',
            data: { state: 'running', count: attachmentCount }
          })
        }

        const messagesForModel = await transformFileParts(messagesToConvert, {
          modelHasVision: modelSupportsVision(model),
          userId
        })

        if (attachmentCount > 0) {
          // Same part id — replaces the 'running' entry in place.
          writer.write({
            type: 'data-attachments',
            id: 'attachments',
            data: {
              state: 'done',
              count: attachmentCount,
              durationMs: Math.round(performance.now() - attachmentsStart)
            }
          })
        }

        // The classifier promise has been running since before the stream
        // started; its step is shown after attachment prep so the visible
        // step order matches what the user is actually waiting on (the
        // reported duration still measures from the true kickoff).
        if (!bypassClassifier) {
          writer.write({
            type: 'data-classifier',
            id: 'classifier',
            data: { state: 'running' }
          })
        }

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

          // Push the title to the client the moment it resolves (a few seconds
          // in), instead of making it wait for the whole turn. It is only
          // PERSISTED in onFinish via persistStreamResults, so without this the
          // browser has no way to learn it and the header sits on "Untitled"
          // until a navigation refetches the chat — which is exactly what users
          // saw. Fire-and-forget: the writer is still open (the answer streams
          // for far longer than title generation takes), and a failure here must
          // never affect the turn.
          void titlePromise
            .then(title => {
              if (title && title !== DEFAULT_CHAT_TITLE) {
                writer.write({
                  type: 'data-title',
                  id: 'title',
                  data: { title }
                })
              }
            })
            .catch(() => {})
        }

        classification = await classificationPromise

        // Past-conversation recall: retrieve here (not in createResearcher)
        // because this scope owns both the resolved standaloneQuery and the
        // stream writer needed for the attribution chips.
        const recall = await getRecallInjection(
          userId,
          classification?.standaloneQuery || latestMessageText,
          chatId
        )
        if (recall.hits.length > 0) {
          writer.write({
            type: 'data-recall',
            id: 'recall',
            data: {
              chats: [
                ...new Map(
                  recall.hits.map(h => [
                    h.chatId,
                    { chatId: h.chatId, title: h.chatTitle }
                  ])
                ).values()
              ]
            }
          })
        }

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

        if (!bypassClassifier) {
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

        // Get the researcher agent with parent trace ID, search mode,
        // sources, and the classifier's decision for this turn.
        const researchAgent = await researcher({
          model: context.modelId,
          modelConfig: model,
          parentTraceId,
          searchMode,
          sources,
          systemInstructions,
          abortSignal,
          skipSearch: classification.skipSearch,
          standaloneQuery: classification.standaloneQuery,
          needsRecent: classification.needsRecent,
          intent: classification.intent,
          expandedQueriesPromise,
          userId,
          currentChatId: chatId,
          recallBlock: recall.block
        })

        llmStart = performance.now()
        perfLog(
          `researchAgent.stream - Start: model=${context.modelId}, searchMode=${searchMode}, skipSearch=${classification.skipSearch}`
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

        // Log the session-total usage once the stream settles (does not
        // block the response; consumeStream above already drives it to
        // completion).
        if (isUsageLogging()) {
          Promise.resolve(result.totalUsage)
            .then(usage =>
              logUsage({ scope: 'total', modelId: context.modelId }, usage)
            )
            .catch(() => {})
        }

        writer.merge(result.toUIMessageStream({ sendStart: false }))
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

          // Long-term memory: extract durable user facts from this turn
          // (async, non-blocking — mirrors title generation). Fully guarded
          // + fail-safe.
          if (userId && process.env.MEMORY_ENABLED !== 'off') {
            void (async () => {
              try {
                if (!(await isMemoryEnabled(userId))) return
                const userText = getTextFromParts(message?.parts)
                if (!userText?.trim()) return
                const candidates = await extractMemories({
                  userMessage: userText,
                  standaloneQuery: classification?.standaloneQuery
                })
                if (candidates.length > 0) {
                  await saveCandidates(userId, candidates, {
                    sourceChatId: chatId
                  })
                }
              } catch (error) {
                console.error('[memory] extraction failed:', error)
              }
            })()
          }

          // Conversation recall: index this turn's question + answer (async,
          // non-blocking — mirrors the memory extraction above). Uses
          // extractIndexableText rather than getTextFromParts so the
          // assistant side indexes only the final answer — not the
          // inter-step narration the researcher (a multi-step ToolLoopAgent)
          // emits as text parts between tool calls, and not citation
          // markers like `[1](#anchor)` — all of which dilute the
          // embedding (see lib/memory/extract-indexable-text.ts).
          if (userId && process.env.RECALL_ENABLED !== 'off') {
            void (async () => {
              try {
                const userText = extractIndexableText(
                  'user',
                  (message?.parts ?? []).map(p => ({
                    type: p.type,
                    text: (p as any).text ?? null
                  }))
                )
                if (userText?.trim() && message?.id) {
                  await indexMessage(
                    userId,
                    chatId,
                    message.id,
                    'user',
                    userText
                  )
                }
                const answerText = extractIndexableText(
                  'assistant',
                  (cleanedMessage?.parts ?? []).map(p => ({
                    type: p.type,
                    text: (p as any).text ?? null
                  }))
                )
                if (answerText?.trim() && cleanedMessage?.id) {
                  await indexMessage(
                    userId,
                    chatId,
                    cleanedMessage.id,
                    'assistant',
                    answerText
                  )
                }
              } catch (error) {
                console.error('[recall] indexing failed:', error)
              }
            })()
          }
        } finally {
          if (langfuse) {
            await langfuse.flushAsync()
          }
        }
      },
      onError: (error: unknown) => {
        console.error('Stream response error:', error)
        return serializePublicError(error)
      }
    })

    return createUIMessageStreamResponse({
      stream,
      // Tell intermediary proxies/CDNs (e.g. Cloudflare) not to rewrite this
      // body (Auto Minify, Rocket Loader, etc.) — those transformations
      // require buffering the full response, which defeats streaming and
      // makes the progress indicator only appear once generation finishes.
      // `no-cache` is restated alongside it since the AI SDK's own default
      // header would otherwise be dropped (the merge only fills in a default
      // for a header key that isn't already present).
      headers: {
        'Cache-Control': 'no-cache, no-transform'
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
