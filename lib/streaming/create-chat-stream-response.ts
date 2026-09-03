import {
  consumeStream,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  pruneMessages
} from 'ai'
import { randomUUID } from 'crypto'
import { Langfuse } from 'langfuse'

import { resolveFlowVariant } from '@/lib/agents/flows/variants'
import { researcher } from '@/lib/agents/researcher'
import { modelSupportsVision } from '@/lib/config/model-vision'
import {
  createPublicErrorResponse,
  serializePublicError
} from '@/lib/errors/public-error'
import { isTracingEnabled } from '@/lib/utils/telemetry'
import { isVoiceEnabled } from '@/lib/voice/config'
import { emitSpokenGist } from '@/lib/voice/emit-spoken-gist'

import { loadChatUncached } from '../actions/chat'
import { resolveExpandedQueries } from '../agents/classifier-expansion'
import { extractMemories } from '../agents/memory-extractor'
import {
  classifyQuery,
  type QueryClassification
} from '../agents/query-classifier'
import { expandQuery } from '../agents/query-expander'
import { generateChatTitle } from '../agents/title-generator'
import { isMemoryEnabled } from '../db/memory-actions'
import { retrieveUrlChunks } from '../embeddings/url-rag'
import { extractIndexableText } from '../memory/extract-indexable-text'
import { indexMessage } from '../memory/recall-index'
import { getRecallInjection } from '../memory/recall-inject'
import { saveCandidates } from '../memory/write'
import {
  type FullContentByToolCall,
  rehydrateFullContent
} from '../search/rehydrate-full-content'
import { durableLatencySink } from '../telemetry/latency-store'
import { auditCitations, extractCitedSourceUrls } from '../utils/citation'
import {
  getMaxAllowedTokens,
  shouldTruncateMessages,
  truncateMessages
} from '../utils/context-window'
import { getTextFromParts } from '../utils/message-utils'
import { perfLog, perfTime } from '../utils/perf-logging'
import { resolveContextWindow } from '../utils/resolve-context-window'
import { isUsageLogging, logUsage } from '../utils/usage-logging'

import { chooseRecall } from './helpers/choose-recall'
import { convertDataPart } from './helpers/convert-data-part'
import {
  buildDocumentRetrievalArtifacts,
  type DocumentRetrievalArtifacts,
  type DocumentRetrievalInput,
  documentSourceId
} from './helpers/document-retrieval-part'
import { firstChunkTimer } from './helpers/first-chunk-timer'
import { persistStreamResults } from './helpers/persist-stream-results'
import { prepareMessages } from './helpers/prepare-messages'
import { smoothAndStripNarration } from './helpers/smooth-and-strip-narration'
import { streamPartTimer } from './helpers/stream-part-timer'
import { stripNarrationFromMessage } from './helpers/strip-narration-from-message'
import { stripReasoningParts } from './helpers/strip-reasoning-parts'
import { stripSpecFromMessages } from './helpers/strip-spec-from-messages'
import { transformFileParts } from './helpers/transform-file-parts'
import type { StreamContext } from './helpers/types'
import { unregisterGeneration } from './active-generations'
import { createFlowProgressEmitter, type ProgressWriter } from './flow-progress'
import { LatencyTracker } from './latency-tracker'
import {
  clearActiveStreamId,
  getResumableStreamContext,
  setActiveStreamId
} from './resumable-stream-context'
import { BaseStreamConfig } from './types'

// Constants
const DEFAULT_CHAT_TITLE = 'Untitled'

// Cap on how many attached documentRetrieval sources are injected per turn.
// Every prior attachment re-retrieves each turn (spec §7) and each source's
// assistant-tool-call + tool-result pair is pushed onto modelMessages AFTER
// truncateMessages already ran — so the injected excerpts ESCAPE the context-
// window budget entirely. With many/large attachments this can push the request
// past the model's window → a provider 400 that kills a turn that DID retrieve,
// which is not fail-open. Per-source chunks are already bounded (topK=10), so an
// 8-source cap bounds the worst case predictably (a token-budget system is the
// documented Slice-2 fast-follow, deliberately out of scope here).
const MAX_INJECTED_DOC_SOURCES = 8

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
    stopController,
    isNewChat,
    searchMode,
    sources,
    systemInstructions,
    voice
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
    const latency = new LatencyTracker(
      {
        chatId,
        mode: searchMode ?? 'balanced',
        modelId: context.modelId
      },
      undefined,
      // Mirror the line into Redis: Docker's json-file driver is per-container,
      // so every prod rebuild wiped the history we need to compare against.
      durableLatencySink
    )
    perfLog(
      `prepareMessages - Invoked: trigger=${trigger}, isNewChat=${isNewChat}`
    )
    const messagesToModel = await prepareMessages(context, message)
    perfTime('prepareMessages completed (stream)', prepareStart)
    latency.mark('prepare_ms', performance.now() - prepareStart)

    // Decide whether this turn needs new research or is answerable directly
    // from the existing conversation (see query-classifier.ts). Kicked off
    // here, in parallel with the message-prep pipeline below, and awaited
    // just before constructing the researcher agent — the classifier call
    // (local, ~1-8s) overlaps with that work instead of adding pure latency.
    // Bypassed (always search) in three unambiguous cases not worth a
    // classifier call:
    // - the message contains a URL: the search-mode prompts already say to
    //   fetch it directly;
    // - the user hit Retry (regenerate): the classifier is deterministic
    //   (temperature 0), so re-classifying would reproduce a wrong skip
    //   verbatim — treating Retry as "do it properly, with research" gives
    //   the user a built-in override for misclassified turns.
    // - speed mode (searchMode==='speed'): the classifier is a ~9s local
    //   Ollama call whose only outputs speed uses are skipSearch and
    //   standaloneQuery — and the default already gives speed exactly what it
    //   wants (skipSearch:false → always search; standaloneQuery:raw → search
    //   the raw query; expandedQueries:[] → speed skips expansion anyway, see
    //   wantsExpansion below). So speed takes the default classification
    //   instead of paying the classifier wall.
    const latestMessageForModel = messagesToModel[messagesToModel.length - 1]
    const latestMessageText = getTextFromParts(latestMessageForModel?.parts)
    const containsUrl = /https?:\/\/\S+/i.test(latestMessageText)
    const isRegenerate = trigger?.startsWith('regenerate') ?? false
    const bypassClassifier =
      containsUrl || isRegenerate || searchMode === 'speed'
    const classifyStart = performance.now()
    const classificationPromise: Promise<QueryClassification> = bypassClassifier
      ? Promise.resolve({
          skipSearch: false,
          standaloneQuery: latestMessageText,
          needsRecent: false,
          // TRUE for BOTH bypass reasons, so a bypassed turn behaves exactly
          // as it did before this gate existed. The gate may only engage where
          // the classifier actually ran and deliberately said false.
          //
          // Worth stating why the obvious alternative is wrong: a URL turn
          // looks like it needs no web sources — it already has its page. But
          // needsSources=false routes to STABLE_KNOWLEDGE_PROMPT, which does
          // not advertise `fetch`, and a URL turn's whole job is fetching that
          // page. Retry likewise wants research: it is the user's override for
          // a turn that came back wrong, and ungrounded is the usual reason.
          needsSources: true,
          intent: 'general' as const,
          // Bypassed turns never asked the model, so there are no fused
          // expansions; the standalone expander supplies them.
          expandedQueries: []
        })
      : classifyQuery({ messages: messagesToModel, abortSignal })

    // Start recall speculatively on the raw message, concurrent with the
    // classifier, so a research turn whose standalone query matches the raw
    // message pays no serial recall wait (see chooseRecall). getRecallInjection
    // is fail-safe (never rejects); on a gated/refetch turn this result is
    // simply not awaited. userId-less turns have no recall.
    // On a gated (skipSearch) turn this speculative recall still runs to
    // completion in the background and is discarded — gating removes the
    // user-facing wait, not the reranker load.
    // Speed mode skips past-conversation recall (personalization) to stay
    // fast: with the classifier bypassed above, chooseRecall returns
    // 'speculative' (standaloneQuery===latestMessageText), which awaits this
    // promise — so resolving it instantly empty makes recall_ms ~0 and imposes
    // no reranker load.
    const speculativeRecall =
      userId && searchMode !== 'speed'
        ? getRecallInjection(userId, latestMessageText, chatId)
        : Promise.resolve({ block: '', hits: [] })

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
    // Resolves once token usage has been folded into the latency line; onFinish
    // awaits it so emit() never races the usage handler.
    let usageRecorded: Promise<void> = Promise.resolve()
    // Full crawled text per search tool call, collected during the turn and
    // swapped in just before persistence so conversation HISTORY keeps the
    // depth a follow-up needs, while the live prompt only carried excerpts.
    const fullContentSink: FullContentByToolCall = new Map()

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

        // Only resolve vision capability when there's actually an attachment
        // to transform — otherwise this would hit Ollama's /api/show on every
        // plain chat turn for nothing.
        const modelHasVision =
          attachmentCount > 0 ? await modelSupportsVision(model) : false
        // Ready non-image documents surface their ranked chunks here (instead of
        // an inline excerpt text part) so they can be assembled below into a
        // CITABLE `documentRetrieval` tool result — reusing transformFileParts'
        // existing resolution + user-scope guard + single queryFileChunks call.
        const documentSources: DocumentRetrievalInput[] = []
        const messagesForModel = await transformFileParts(messagesToConvert, {
          modelHasVision,
          userId,
          documentSink: documentSources
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
          latency.mark('attachments_ms', performance.now() - attachmentsStart)
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

        // Size truncation by the model's REAL window (probed from the
        // provider, cached per model). Unknown window => no truncation.
        const contextWindow = await resolveContextWindow(model)
        if (shouldTruncateMessages(modelMessages, model, contextWindow)) {
          const maxTokens = getMaxAllowedTokens(model, contextWindow) as number
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
        latency.mark('classify_ms', performance.now() - classifyStart)

        // Past-conversation recall: retrieve here (not in createResearcher)
        // because this scope owns both the resolved standaloneQuery and the
        // stream writer needed for the attribution chips.
        const recallStart = performance.now()
        const recallDecision = chooseRecall({
          skipSearch: classification.skipSearch,
          standaloneQuery: classification.standaloneQuery,
          latestMessageText
        })
        const recall =
          recallDecision === 'gated'
            ? { block: '', hits: [] }
            : recallDecision === 'speculative'
              ? await speculativeRecall
              : await getRecallInjection(
                  userId,
                  classification.standaloneQuery,
                  chatId
                )
        latency.mark('recall_ms', performance.now() - recallStart)
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
        // expand_ms measures the promise's own lifetime, not a blocking await:
        // expansion deliberately overlaps the work below, so timing it here
        // records how long it was in flight without serialising it. Only the
        // branch that actually expands is marked — a skipped turn would
        // otherwise log a meaningless 0.
        // The classifier now returns expandedQueries from the SAME call that
        // classifies, removing a second serial round trip to the same model on
        // the same host (measured 6.6-12.3s, and it could not start until the
        // classifier resolved because it needed standaloneQuery). The
        // standalone expander survives as a fallback for a model that returns
        // none, so an older or refusing model cannot silently narrow the
        // search. expand_ms is now ~0 whenever the fused path supplied them.
        const expandStart = performance.now()
        // Captured: the fallback runs inside a closure, and `classification`
        // is a reassignable outer binding TypeScript cannot narrow there.
        const resolved = classification
        const wantsExpansion = !resolved.skipSearch && searchMode !== 'speed'
        const expandedQueriesPromise = wantsExpansion
          ? resolveExpandedQueries({
              fromClassifier: resolved.expandedQueries,
              wantsExpansion: true,
              fallback: () =>
                expandQuery({
                  standaloneQuery: resolved.standaloneQuery,
                  abortSignal
                })
            }).then(queries => {
              latency.mark('expand_ms', performance.now() - expandStart)
              return queries
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

        // ── Attached-source grounding (chat with docs & URLs) ────────────────
        // Lift document/URL retrieval OUT of the plain-text injection and INTO
        // the stream so the auto-retrieved chunks become CITABLE. Documents were
        // already ranked during transformFileParts (documentSources); pasted
        // URLs are fetched + ranked here (ephemeral, per-turn). Each non-empty
        // source becomes a synthetic `documentRetrieval` tool call: its UI part
        // is written to the stream (so the client's extractCitationMaps sees it)
        // and a matching model-message pair is appended AFTER prune/truncate (so
        // it cannot be stripped) — exactly the SPIKE's mechanism. Everything is
        // fail-open per source: a failure logs + skips that source and NEVER
        // affects the answer (mirrors transformFileParts / emitSpokenGist).
        const retrievalQuery =
          classification.standaloneQuery || latestMessageText

        // Pasted URLs are per-turn only, so retrieve just THIS turn's user
        // message (submit → config.message; regenerate → last user message in
        // the model transcript). Documents, by contrast, stay citable across the
        // whole conversation because transformFileParts re-ranks every attached
        // file each turn (matching how its excerpts were injected before).
        const latestUserParts: any[] =
          (message?.parts as any[] | undefined) ??
          ([...messagesForModel].reverse().find(m => m.role === 'user')
            ?.parts as any[] | undefined) ??
          []
        const urlSources = (
          await Promise.all(
            latestUserParts
              .filter(
                (p: any) =>
                  p?.type === 'data-sourceUrl' &&
                  typeof p?.data?.url === 'string' &&
                  p.data.url
              )
              .map(async (p: any): Promise<DocumentRetrievalInput | null> => {
                const url = p.data.url as string
                try {
                  const retrieved = await retrieveUrlChunks(
                    url,
                    retrievalQuery,
                    10
                  )
                  if (!retrieved || retrieved.chunks.length === 0) return null
                  return {
                    sourceId: documentSourceId('url', url),
                    title: retrieved.title || url,
                    url,
                    chunks: retrieved.chunks,
                    query: retrievalQuery
                  }
                } catch (error) {
                  console.warn('[docs] URL retrieval skipped:', error)
                  return null
                }
              })
          )
        ).filter((s): s is DocumentRetrievalInput => s !== null)

        // Merge documents + URLs, deduped by the deterministic sourceId so the
        // same file/URL never yields two tool calls under one toolCallId.
        const documentArtifacts: DocumentRetrievalArtifacts[] = []
        const seenSourceIds = new Set<string>()
        for (const src of [
          ...documentSources.map(s => ({ ...s, query: retrievalQuery })),
          ...urlSources
        ]) {
          if (seenSourceIds.has(src.sourceId)) continue
          seenSourceIds.add(src.sourceId)
          try {
            const artifacts = buildDocumentRetrievalArtifacts(src)
            if (artifacts) documentArtifacts.push(artifacts)
          } catch (error) {
            // buildDocumentResults throws on a relative URL — skip that source
            // only (fail-open), never the whole turn.
            console.warn(
              `[docs] skipped uncitable source ${src.sourceId}:`,
              error
            )
          }
        }

        // Bound the injected sources before BOTH the injection loop and the
        // prompt-clause mapping below, so the model input and the researcher's
        // citation-permission clause stay in sync over the same capped set.
        // The array is ordered history-docs-first then this turn's URLs last, so
        // keeping the LAST N biases toward the most-recently-attached docs plus
        // this turn's URLs. Never a silent truncation — say what was dropped.
        let injectedDocSources = documentArtifacts
        if (documentArtifacts.length > MAX_INJECTED_DOC_SOURCES) {
          const dropped = documentArtifacts.length - MAX_INJECTED_DOC_SOURCES
          injectedDocSources = documentArtifacts.slice(
            -MAX_INJECTED_DOC_SOURCES
          )
          console.warn(
            `[docs] injected sources capped at ${MAX_INJECTED_DOC_SOURCES}; dropped ${dropped} oldest attached source(s) to stay within the model context window`
          )
        }

        if (injectedDocSources.length > 0) {
          for (const a of injectedDocSources) {
            // (a) Write the UI part as two raw chunks (no `dynamic` flag → the
            //     client reducer builds a static tool-documentRetrieval part
            //     that lands on onFinish's persisted assistant message).
            writer.write(a.streamChunks[0])
            writer.write(a.streamChunks[1])
            // (b) Surface the same citable id to the MODEL as an assistant
            //     tool-call + tool tool-result pair, appended AFTER prune/
            //     truncate so it survives into the generation input.
            modelMessages.push(a.modelMessages[0], a.modelMessages[1])
          }
          perfLog(
            `[docs] injected ${injectedDocSources.length} citable documentRetrieval source(s)`
          )
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
          needsSources: classification.needsSources,
          intent: classification.intent,
          expandedQueriesPromise,
          userId,
          currentChatId: chatId,
          recallBlock: recall.block,
          fullContentSink,
          // Name each injected retrieval's citable toolCallId so the prompt can
          // permit citing it (without this the model discards the anchor). Uses
          // the capped set so the clause matches exactly what was injected.
          documentRetrievalSources: injectedDocSources.map(a => ({
            toolCallId: a.toolCallId,
            title: a.part.output.results[0]?.title ?? ''
          })),
          // Fold each search/fetch call's stage timings into the turn's
          // [latency] line. addToolTiming is itself guarded, so this can never
          // break a turn.
          onToolTiming: (kind, stages) => latency.addToolTiming(kind, stages)
        })

        llmStart = performance.now()
        perfLog(
          `researchAgent.stream - Start: model=${context.modelId}, searchMode=${searchMode}, skipSearch=${classification.skipSearch}`
        )
        // Server-generated progress lines for the research panel. The panel
        // already renders `reasoning` parts and shows "Completed N steps"; it
        // just had nothing to display, because the model emits ~1.9s of
        // reasoning on a 90s turn. See lib/streaming/flow-progress.ts.
        const flowProgress = createFlowProgressEmitter(
          resolveFlowVariant(process.env.FLOW_VARIANT),
          writer as unknown as ProgressWriter
        )
        const stepHooks =
          flowProgress || isUsageLogging()
            ? {
                onStepFinish: (step: {
                  usage?: unknown
                  providerMetadata?: unknown
                  toolCalls?: { toolName: string }[]
                }) => {
                  if (isUsageLogging()) {
                    logUsage(
                      { scope: 'step', modelId: context.modelId },
                      step.usage as never,
                      step.providerMetadata as never
                    )
                  }
                  if (flowProgress) {
                    stepIndex += 1
                    // Accumulate the step BEFORE reporting: a status line that
                    // says "1 search" has to be able to see that search. This
                    // array was previously declared and never populated, which
                    // silently made every tool-count-based status line return
                    // null — the panel stayed empty and looked like the
                    // emitter was broken rather than the input.
                    recordedSteps.push({
                      toolCalls: (
                        (step as { toolCalls?: { toolName: string }[] })
                          .toolCalls ?? []
                      ).map(c => ({ toolName: c.toolName }))
                    })
                    flowProgress({
                      stepNumber: stepIndex,
                      steps: recordedSteps,
                      skipSearch: Boolean(classification?.skipSearch)
                    })
                  }
                }
              }
            : {}
        let stepIndex = -1
        const recordedSteps: { toolCalls?: { toolName: string }[] }[] = []

        const result = await researchAgent.stream({
          messages: modelMessages,
          abortSignal,
          experimental_transform: smoothAndStripNarration(),
          ...(stepHooks as object)
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

        // totalUsage is the SUM over steps, so it cannot size the prompt on a
        // multi-step research turn; result.usage is the LAST step — the actual
        // answering prompt. Both are recorded: the sum for cost, the last step
        // for judging prompt-size changes. Settles independently of the UI
        // stream, so onFinish awaits the handle below rather than assuming it
        // already resolved.
        usageRecorded = Promise.all([
          Promise.resolve(result.totalUsage),
          Promise.resolve(result.usage).catch(() => undefined)
        ])
          .then(([total, lastStep]) =>
            latency.markUsage(
              {
                inputTokens: total?.inputTokens,
                outputTokens: total?.outputTokens
              },
              lastStep?.inputTokens
            )
          )
          .catch(() => {})

        writer.merge(
          result
            .toUIMessageStream({ sendStart: false })
            .pipeThrough(firstChunkTimer(() => latency.markFirstToken()))
            .pipeThrough(streamPartTimer(type => latency.markStreamPart(type)))
        )

        // Voice "read-aloud" turns only: once the answer's final step has
        // settled, condense it and stream a spoken gist as a data part. This
        // MUST live inside execute — it is the only scope where `writer` is
        // still open; onFinish runs after the stream controller has already
        // closed (writes there are silently dropped). `result.text` is the
        // FINAL step's text (the answer produced after the last tool call) —
        // the same content extractIndexableText targets for recall, so it is
        // clean of the inter-step narration earlier text parts carry.
        // Strictly gated: a normal (non-voice) turn skips this entirely and is
        // byte-for-byte unchanged — no extra part, no extra model call.
        if (voice && isVoiceEnabled()) {
          try {
            const answerText = await result.text
            // The SDK writer's `write` is strongly typed to UI message chunks;
            // emitSpokenGist takes a minimal structural writer. Bridge the two
            // the same way flowProgress does above (writer as unknown as …).
            await emitSpokenGist(
              writer as unknown as { write: (part: unknown) => void },
              answerText
            )
          } catch (error) {
            // A voice-gist failure must never affect the written answer.
            console.warn('[voice] spoken-gist emit skipped:', error)
          }
        }
      },
      onFinish: async ({ responseMessage, isAborted }) => {
        try {
          // Turn is done (or aborted) — drop it from the Stop registry so the
          // in-memory map doesn't leak.
          if (stopController) unregisterGeneration(chatId, stopController)
          perfTime('researchAgent.stream completed', llmStart)
          // Bounded: a stalled usage promise must not hold back the line.
          await Promise.race([
            usageRecorded,
            new Promise<void>(resolve => setTimeout(resolve, 1000))
          ])
          // needsRecent and needsSources ride along because together with
          // skipSearch they determine which of the three prompt/tool modes the
          // turn got (resolveTurnMode). Without them a turn that answered
          // without searching is indistinguishable from one that searched and
          // found nothing, which makes the gate's real-world firing rate
          // unmeasurable — and the gate is a behaviour change worth watching.
          // Audited before the isAborted guard below so a turn that was cut
          // short still reports the citations it had already written.
          if (responseMessage) {
            latency.markCitations(auditCitations(responseMessage))
            // Shadow (SEARCH_CROP_POSITION_SHADOW): log which source URLs the
            // answer actually CITED, so the crawl-time [crop-pos] per-source
            // detail can be joined offline (by chatId) to a CITATION-scoped crop
            // cost — the truer number than v1's read-source figure. Best-effort;
            // a measurement must never break the turn.
            if (process.env.SEARCH_CROP_POSITION_SHADOW === 'true') {
              try {
                const cited = extractCitedSourceUrls(responseMessage)
                if (cited.length > 0) {
                  console.log(
                    `[cite-urls] ${JSON.stringify({ chatId, cited })}`
                  )
                }
              } catch {
                /* shadow citation logging is best-effort */
              }
            }
          }
          latency.emit({
            skipSearch: classification?.skipSearch ?? null,
            needsRecent: classification?.needsRecent ?? null,
            needsSources: classification?.needsSources ?? null
          })
          if (isAborted || !responseMessage) return

          // Clean the assembled responseMessage of any narration preamble
          // before persistence. The stream transform already filters
          // outgoing text-delta, but if the stream was interrupted or the
          // transform state got out of sync, the assembled message may
          // still contain the leading narration. Strip it here so the
          // DB row is clean even on a partial response.
          const cleanedMessage = rehydrateFullContent(
            stripNarrationFromMessage(responseMessage),
            fullContentSink
          )

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

          // NB: the active-stream pointer is deliberately NOT cleared here. It
          // (and the Redis buffer) expire via their 300s TTL, so a client that
          // returns AFTER the turn finished can still `resumeStream()` and have
          // the full buffered stream replayed — the SDK merges by message id and
          // catches the client up to the final answer, no refetch needed.

          // Long-term memory: extract durable user facts from this turn
          // (async, non-blocking — mirrors title generation). Fully guarded
          // + fail-safe.
          if (userId && process.env.MEMORY_ENABLED !== 'off') {
            void (async () => {
              // One structured line per turn, whatever happens. Without it the
              // three benign outcomes (gated off, nothing worth keeping, kept
              // but deduped against an existing memory) are indistinguishable
              // from a silent failure — they all just leave the table unchanged.
              // That ambiguity is exactly what made "staging has no memories"
              // unanswerable without reading the database.
              const startedAt = performance.now()
              const emit = (
                outcome: string,
                extra: Record<string, unknown> = {}
              ) => {
                try {
                  console.log(
                    `[memory] ${JSON.stringify({
                      chatId,
                      outcome,
                      ...extra,
                      ms: Math.round(performance.now() - startedAt)
                    })}`
                  )
                } catch {
                  // Telemetry must never break a turn.
                }
              }
              try {
                if (!(await isMemoryEnabled(userId))) return emit('disabled')
                const userText = getTextFromParts(message?.parts)
                if (!userText?.trim()) return emit('no_user_text')
                const candidates = await extractMemories({
                  userMessage: userText,
                  standaloneQuery: classification?.standaloneQuery
                })
                if (candidates.length === 0) return emit('no_candidates')
                const saved = await saveCandidates(userId, candidates, {
                  sourceChatId: chatId
                })
                // saved < candidates means the writer merged or dropped some
                // against existing memories — a real outcome, not a failure.
                emit('saved', { candidates: candidates.length, saved })
              } catch (error) {
                emit('failed', {
                  error: error instanceof Error ? error.message : String(error)
                })
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
      // Mirror the SSE to Redis so a disconnected client (backgrounded mobile
      // tab) can reconnect and resume the live stream. The connected client
      // keeps its own low-latency copy — this callback gets a tee'd copy. If
      // Redis pub/sub isn't available it degrades to a plain server-side drain
      // (the turn still completes + persists via the timeout-only signal).
      async consumeSseStream({ stream }) {
        const rsc = await getResumableStreamContext()
        if (!rsc) {
          await consumeStream({ stream })
          return
        }
        const streamId = generateId()
        try {
          // Point the chat at this stream FIRST so a reconnect mid-generation
          // finds it, then hand the stream to the resumable context (which
          // publishes to Redis and drives it to completion).
          await setActiveStreamId(chatId, streamId)
          await rsc.createNewResumableStream(streamId, () => stream)
        } catch (error) {
          console.warn('[resumable-stream] publish failed; draining:', error)
          await clearActiveStreamId(chatId)
          await consumeStream({ stream })
        }
      }
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
