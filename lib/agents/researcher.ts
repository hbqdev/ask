import type { FlowStep, FlowStepOverrides } from './flows/types'

// Structural shapes for the two SDK callbacks, so the casts above stay
// narrow and readable rather than `any`.
type FlowStepArgs = { stepNumber: number; steps: readonly unknown[] }
type FlowStopArgs = { steps: readonly unknown[] }
import { stepCountIs, tool, ToolLoopAgent } from 'ai'

import type { ResearcherTools } from '@/lib/types/agent'
import { type Model } from '@/lib/types/models'

import { getMemoryInjection } from '../memory/inject'
import { getRelatedQuestionsSpecPrompt } from '../render/prompt'
import type { FullContentByToolCall } from '../search/rehydrate-full-content'
import { calculateTool } from '../tools/calculate'
import { fetchTool } from '../tools/fetch'
import {
  createGenerateImageTool,
  isImageGenEnabled
} from '../tools/generate-image'
import { createQuestionTool } from '../tools/question'
import { createRecallTool } from '../tools/recall'
import { createRememberTool } from '../tools/remember'
import { createSearchTool } from '../tools/search'
import { createTodoTools } from '../tools/todo'
import { weatherTool } from '../tools/weather'
import { SearchMode, SearchSources } from '../types/search'
import { getModel } from '../utils/registry'
import { isTracingEnabled } from '../utils/telemetry'

import {
  applyAnswerStepReserve,
  buildProvisionedToolsNote,
  buildSourceBlock,
  type PipelineRetrieval,
  provisionTurnTools,
  shouldInjectRetrieval
} from './flows/pipeline'
import { resolveFlowVariant } from './flows/variants'
import { IMAGE_TOOL_GUIDANCE } from './prompts/image-tool-guidance'
import {
  getAdaptiveModePrompt,
  getQualityModePrompt,
  SPEED_MODE_PROMPT
} from './prompts/search-mode-prompts'

// Used when the query classifier (lib/agents/query-classifier.ts) decides
// this turn needs no new research — a pure clarification/confirmation about
// something already established in this conversation. Tools stay available
// as an escape hatch: the classifier is a small model gating a bigger one,
// and when it's wrong in the skip direction the researcher must be able to
// recover on its own (search) and must not lose unrelated capabilities
// (calculate/fetch/get_weather) just because no NEW research is expected.
// This replaces the search-mode prompt entirely rather than layering on
// top of it.
const DIRECT_ANSWER_PROMPT = `Instructions:

You are continuing an ongoing conversation. The user's latest message looks answerable directly from what has already been established in this conversation — no new research is expected for this turn.

- Default to answering directly and concisely from the existing conversation context, without calling any tools.
- Escape hatch — you still have tools, use one ONLY if actually required to answer correctly:
  - If, while answering, you realize a needed fact is NOT actually established above (or what's above may be stale for a time-sensitive claim), run the \`search\` tool rather than guessing from memory. If you do search, cite what you use (only toolCallIds from searches you actually executed this turn; never invent anchors).
  - If the reply requires arithmetic on numbers from the conversation (recompute, totals, unit conversions), use \`calculate\` instead of doing mental math.
  - If the user asks you to re-quote or re-check a page already linked in this conversation, you may \`fetch\` that URL.
- Do not add citations when you used no tools — you're restating what was already discussed.
- Format as Markdown. A heading is optional: use one only if it genuinely helps organize a longer answer; for a short confirmation or clarification, plain prose is fine.
- ALWAYS respond in the user's language.

${getRelatedQuestionsSpecPrompt()}
`

/** Same query modulo case, surrounding space and internal run-length. */
function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ')
}

const URL_ONLY = /^https?:\/\/\S+$/i

// Wraps the search tool to deduplicate results across calls within one request.
// When the same URL appears in a later search, it's filtered out so the model
// doesn't see redundant content.
//
// It also answers the question "why do tool-call counts vary so wildly between
// models on identical input?". Measured on one turn: the first search returned
// 92,631 bytes (it runs deep and crawls); every follow-up returns snippets, and
// dedup then strips URLs already seen. `PostgreSQL 18.4` was issued three times
// and returned 319 bytes each time; `PostgreSQL 18.4 release notes` returned
// 2,643 bytes then 333 on repeat — 87% removed.
//
// A near-empty payload is indistinguishable from a genuinely empty search, so
// the model reads suppression as failure and searches AGAIN. How hard it
// retries is a per-model trait, which is the whole source of the variance:
// kimi-k2.6 issued 17 searches on that turn (three verbatim repeats, one URL
// sent as a query, one malformed), minimax-m3 issued 2-3 on the same probes.
//
// So the fix is to stop returning an ambiguous signal. A duplicate query gets
// an explicit instruction instead of empty results, and dedup announces itself
// rather than silently shrinking the list.
function wrapSearchToolWithDedup<T extends ReturnType<typeof createSearchTool>>(
  originalTool: T,
  seenUrls: Set<string>,
  seenQueries: Map<string, number>
): T {
  return tool({
    description: originalTool.description,

    inputSchema: originalTool.inputSchema as any,

    toModelOutput: originalTool.toModelOutput as any,

    async *execute(params: any, context: any) {
      const executeFunc = originalTool.execute
      if (!executeFunc) throw new Error('Search tool execute is not defined')

      const rawQuery = String((params as { query?: unknown })?.query ?? '')
      const key = normalizeQuery(rawQuery)

      // A URL is not a query. Observed live: the model sent
      // `https://www.postgresql.org/docs/release/18.4/` to `search`, which
      // searches for the literal string and returns almost nothing — then it
      // searched again. Name the right tool instead of burning the step.
      if (URL_ONLY.test(rawQuery.trim())) {
        console.log(
          `[search] URL routed to guidance instead of search: ${rawQuery.slice(0, 80)}`
        )
        yield {
          state: 'complete' as const,
          results: [],
          images: [],
          query: rawQuery,
          number_of_results: 0,
          notice: `"${rawQuery}" is a URL, not a search query. Call the \`fetch\` tool with this URL to read the page. Do not search for it.`
        }
        return
      }

      const priorCount = key ? seenQueries.get(key) : undefined
      if (priorCount !== undefined) {
        console.log(
          `[search] duplicate query short-circuited: "${rawQuery.slice(0, 60)}"`
        )
        yield {
          state: 'complete' as const,
          results: [],
          images: [],
          query: rawQuery,
          number_of_results: 0,
          duplicateQuery: true,
          notice:
            `You already ran this exact search earlier in this turn; it returned ${priorCount} result(s), which are still in the conversation above. ` +
            `Re-running it cannot return anything new. To get more depth, call \`fetch\` on a specific URL from those results. ` +
            `To explore a different angle, search a MATERIALLY different query. If you have enough to answer, answer now.`
        }
        return
      }

      const result = executeFunc(params, context)
      const iterable =
        result &&
        typeof result === 'object' &&
        Symbol.asyncIterator in (result as object)
          ? (result as AsyncIterable<unknown>)
          : (async function* () {
              yield await result
            })()

      for await (const chunk of iterable) {
        const c = chunk as { state?: string; results?: Array<{ url?: string }> }
        if (c.state === 'complete' && Array.isArray(c.results)) {
          const before = c.results.length
          const deduped = c.results.filter(r => {
            if (!r.url) return true
            if (seenUrls.has(r.url)) return false
            seenUrls.add(r.url)
            return true
          })
          if (key) seenQueries.set(key, before)
          const removed = before - deduped.length
          // Announce suppression. Silently handing back a shorter list is what
          // made "already seen" look like "search failed".
          const notice =
            removed > 0
              ? deduped.length === 0
                ? `All ${before} result(s) for this query were already returned earlier in this turn, so none are repeated here. They remain in the conversation above — use \`fetch\` on one of those URLs for more depth rather than searching again.`
                : `${removed} of ${before} result(s) were already returned earlier in this turn and have been omitted; the ${deduped.length} shown are new.`
              : undefined
          yield notice
            ? { ...c, results: deduped, deduped: removed, notice }
            : { ...c, results: deduped }
        } else {
          yield chunk
        }
      }
    }
  }) as T
}

// Enhanced wrapper function with better type safety and streaming support
function wrapSearchToolForQuickMode<
  T extends ReturnType<typeof createSearchTool>
>(originalTool: T): T {
  return tool({
    description: originalTool.description,
    inputSchema: originalTool.inputSchema,
    // Preserve the original tool's model-output trimming (strips the duplicated
    // citationMap / UI-only images) so quick mode gets the same payload savings.
    toModelOutput: originalTool.toModelOutput,
    async *execute(params, context) {
      const executeFunc = originalTool.execute
      if (!executeFunc) {
        throw new Error('Search tool execute function is not defined')
      }

      // Force optimized type for quick mode
      const modifiedParams = {
        ...params,
        type: 'optimized' as const
      }

      // Execute the original tool and pass through all yielded values
      const result = executeFunc(modifiedParams, context)

      // Handle AsyncIterable (streaming) case
      if (
        result &&
        typeof result === 'object' &&
        Symbol.asyncIterator in result
      ) {
        for await (const chunk of result) {
          yield chunk
        }
      } else {
        // Fallback for non-streaming (shouldn't happen with new implementation)
        const finalResult = await result
        yield finalResult || {
          state: 'complete' as const,
          results: [],
          images: [],
          query: params.query,
          number_of_results: 0
        }
      }
    }
  }) as T
}

// Enforces source selection at the tool level so the model physically cannot
// deviate — but only when exactly one non-web source is selected alone
// (Web off). 'academic' (exclusive) forces search_mode: 'academic' on every
// search call. 'social' (exclusive) forces search_mode: 'social' on every
// search call. Two non-web sources together (Academic+Social, Web off)
// don't get a single fixed search_mode forced — a single search_mode can't
// represent "pick either of these two", so that combination stays advisory
// (model chooses per query, same as any combination that includes Web).
export function wrapSearchToolForSources<
  T extends ReturnType<typeof createSearchTool>
>(originalTool: T, sources: SearchSources): T {
  const hasWeb = sources.includes('web')
  const hasAcademic = sources.includes('academic')
  const hasSocial = sources.includes('social')

  const academicOnly = !hasWeb && hasAcademic && !hasSocial
  const socialOnly = !hasWeb && !hasAcademic && hasSocial

  if (!academicOnly && !socialOnly) return originalTool

  return tool({
    description: originalTool.description,

    inputSchema: originalTool.inputSchema as any,

    toModelOutput: originalTool.toModelOutput as any,

    async *execute(params: any, context: any) {
      const modifiedParams = {
        ...params,
        search_mode: academicOnly ? ('academic' as const) : ('social' as const)
      }

      const executeFunc = originalTool.execute
      if (!executeFunc) throw new Error('Search tool execute is not defined')

      const result = executeFunc(modifiedParams, context)
      const iterable =
        result &&
        typeof result === 'object' &&
        Symbol.asyncIterator in (result as object)
          ? (result as AsyncIterable<unknown>)
          : (async function* () {
              yield await result
            })()

      for await (const chunk of iterable) {
        yield chunk
      }
    }
  }) as T
}

export function getSourcesPromptAddendum(sources: SearchSources): string {
  const hasAcademic = sources.includes('academic')
  const hasSocial = sources.includes('social')
  const hasWeb = sources.includes('web')

  const zeroResultsGuidance =
    '\n\nIf a search returns zero or very few results: retry ONCE with shorter, simpler, less-quoted terms (drop exact-phrase quoting and extra qualifiers first). If results are still sparse after that retry, do not keep second-guessing the date, the model name, or your own knowledge — write the best answer you can from what you found (or say clearly that source coverage was limited for this query) and move on. Never let a thin result set turn into open-ended self-doubt in your response.'

  if (!hasWeb && hasAcademic && !hasSocial) {
    return `\n\n**User-selected Academic focus**: The user has explicitly chosen academic sources. ALL searches are automatically routed to search_mode: 'academic' (Google Scholar, arXiv, Semantic Scholar, PubMed, and other science sources) regardless of what you pass. Prioritize peer-reviewed papers, cite authors and publication years when available, and frame your answer in scholarly terms.${zeroResultsGuidance}`
  }
  if (!hasWeb && !hasAcademic && hasSocial) {
    return `\n\n**User-selected Social focus**: The user has explicitly chosen community discussions. ALL searches are automatically routed to search_mode: 'social' (Reddit, Lemmy, Mastodon, Hacker News) regardless of what you pass. Prioritize real user opinions, personal experiences, and community consensus.${zeroResultsGuidance}`
  }
  if (!hasWeb && hasAcademic && hasSocial) {
    return "\n\n**Academic + Social focus (no Web)**: The user has excluded general web results. For research/science questions use search_mode: 'academic'. For opinions/experiences/community questions use search_mode: 'social'. Choose the appropriate one per query — do not use standard web search."
  }
  if (hasAcademic && hasSocial) {
    return "\n\n**Multi-source mode**: The user has enabled Web + Academic + Social sources. For research/science questions use search_mode: 'academic'. For community perspectives use search_mode: 'social'. For general info use standard web search (search_mode: 'web'). Choose the appropriate source type per query."
  }
  if (hasAcademic) {
    return "\n\n**Academic sources enabled**: For research/science/medical questions use search_mode: 'academic' to get scholarly results. For other questions use standard web search."
  }
  if (hasSocial) {
    return "\n\n**Social sources enabled**: For opinion/experience/community questions use search_mode: 'social'. For factual questions use standard web search."
  }
  return ''
}

// Enhanced researcher function with improved type safety using ToolLoopAgent
// Note: abortSignal should be passed to agent.stream() or agent.generate() calls, not to the agent constructor
export async function createResearcher({
  model,
  modelConfig,
  parentTraceId,
  searchMode = 'balanced',
  sources = ['web'],
  systemInstructions,
  abortSignal,
  skipSearch = false,
  standaloneQuery,
  needsRecent = false,
  needsSources = true,
  expandedQueriesPromise,
  // Auto-detected intent from the query classifier for this turn. Forwarded
  // to the search tool so both search paths additively route to
  // intent-specific engines on top of the general baseline.
  intent = 'general',
  // The authenticated user, if any — used to inject their confirmed
  // long-term memories into the system prompt and to bind the `remember`
  // tool. Undefined (ephemeral/incognito chats) leaves memory fully off.
  userId,
  // The chat this turn belongs to — excluded from recall results so the tool
  // never returns the conversation the user is already in.
  currentChatId,
  fullContentSink,
  // Past-conversation excerpts, retrieved in the streaming layer (it owns the
  // resolved standaloneQuery and the stream writer). Appended to the system
  // prompt next to the feature-A memory block.
  recallBlock,
  // PIPELINE ARCHITECTURE. When set, retrieval already happened — fired on the
  // raw user text before this function was called — and the model gets ONE
  // call with the sources in its prompt and no search tool. See
  // lib/agents/flows/pipeline.ts.
  pipelineRetrievalPromise,
  // The user's RAW message for this turn. Read only by pipeline tool
  // provisioning, which needs the words the user actually typed: a URL, an
  // arithmetic expression or "draw me a…" are cues the classifier does not
  // report (its intent enum is a source taxonomy, not a capability one).
  latestMessageText
}: {
  model: string
  pipelineRetrievalPromise?: Promise<PipelineRetrieval>
  latestMessageText?: string
  modelConfig?: Model
  parentTraceId?: string
  searchMode?: SearchMode
  sources?: SearchSources
  systemInstructions?: string
  abortSignal?: AbortSignal
  // Set by the query classifier (lib/agents/query-classifier.ts) when this
  // turn is a pure clarification about the conversation's own prior answer
  // and needs no new research. Bypasses search-mode tool/prompt selection
  // in favor of DIRECT_ANSWER_PROMPT, which defaults to answering from
  // context but keeps tools as an escape hatch for misclassified turns.
  skipSearch?: boolean
  // The classifier's resolved, standalone version of the user's message
  // (references/pronouns resolved against the conversation). Passed to the
  // research agent as a scoping hint alongside the raw conversation —
  // Perplexica's pattern — not as a rigid replacement query.
  standaloneQuery?: string
  // Set by the query classifier when this turn's answer depends on
  // current/recent information — every search this turn makes narrows
  // SearXNG's time_range to prefer fresh pages.
  needsRecent?: boolean
  // Set by the query classifier when this turn's answer draws on external
  // facts at all — a GROUNDING signal, where needsRecent is a FRESHNESS one.
  // Only the pipeline architecture reads it. Defaults to true because the
  // conservative direction is to ground: a wrong `false` answers from
  // parametric knowledge alone, a wrong `true` costs prompt tokens.
  needsSources?: boolean
  // In-flight query reformulations (lib/agents/query-expander.ts) — the
  // first search of the turn also searches these variants and merges
  // unique results. Passed as a promise so expansion overlaps with prep.
  expandedQueriesPromise?: Promise<string[]>
  intent?: import('../tools/search/intent').SearchIntent
  userId?: string
  // The chat this turn belongs to — excluded from recall results so the tool
  // never returns the conversation the user is already in.
  currentChatId?: string
  fullContentSink?: FullContentByToolCall
  // Past-conversation excerpts, retrieved in the streaming layer (it owns the
  // resolved standaloneQuery and the stream writer). Appended to the system
  // prompt next to the feature-A memory block.
  recallBlock?: string
}) {
  try {
    const currentDate = new Date().toLocaleString()

    // Depth tiering: the first search of a balanced/quality turn goes deep
    // (advanced crawl+rerank); speed and skip turns stay basic. Subsequent
    // searches tier down to basic inside the search tool.
    //
    // Exclusive Academic-only or Social-only turns must also stay basic:
    // 'advanced' routes the first search through /api/advanced-search, which
    // has no way to apply the exclusive academic/social filter (it doesn't
    // honor search_mode at all). Only the basic SearXNG provider's
    // isAcademic/isSocial branches respect search_mode, so exclusive turns
    // need the whole turn — including the first search — on that path.
    const hasWeb = sources.includes('web')
    const hasAcademic = sources.includes('academic')
    const hasSocial = sources.includes('social')
    const exclusiveSourceMode =
      (!hasWeb && hasAcademic && !hasSocial) ||
      (!hasWeb && !hasAcademic && hasSocial)
    const firstSearchDepth: 'basic' | 'advanced' =
      skipSearch || searchMode === 'speed' || exclusiveSourceMode
        ? 'basic'
        : 'advanced'

    // Create model-specific tools with proper typing
    const originalSearchTool = createSearchTool(model, {
      timeRange: needsRecent ? 'month' : undefined,
      expandedQueries: expandedQueriesPromise,
      intent,
      firstSearchDepth,
      chatId: currentChatId,
      fullContentSink
    })
    const askQuestionTool = createQuestionTool(model)
    const todoTools = createTodoTools()

    // Per-request URL dedup: same URL found by multiple searches won't be sent
    // to the model twice (redundant context wastes tokens and confuses citations).
    const seenUrls = new Set<string>()
    // Normalized query -> how many results it returned the first time. Lets a
    // repeat be answered with an instruction instead of an empty list.
    const seenQueries = new Map<string, number>()

    let systemPrompt: string
    let activeToolsList: (keyof ResearcherTools)[] = []
    let maxSteps: number
    let searchTool = originalSearchTool

    if (skipSearch) {
      systemPrompt = DIRECT_ANSWER_PROMPT
      // Escape-hatch tools (see DIRECT_ANSWER_PROMPT): available but the
      // prompt says to use them only when genuinely required. No todoWrite —
      // if a skipped turn somehow needs multi-step planning, the
      // classification was wrong enough that a plain search recovers it.
      activeToolsList = [
        'search',
        'fetch',
        'calculate',
        'get_weather',
        'remember',
        'recall'
      ]
      maxSteps = 10
      searchTool = wrapSearchToolForSources(
        wrapSearchToolWithDedup(originalSearchTool, seenUrls, seenQueries),
        sources
      )
    } else {
      // Configure based on search mode
      switch (searchMode) {
        case 'speed':
          console.log(
            `[Researcher] Speed mode: maxSteps=20, tools=[search, fetch, calculate, get_weather], sources=${JSON.stringify(sources)}`
          )
          systemPrompt = SPEED_MODE_PROMPT
          activeToolsList = [
            'search',
            'fetch',
            'calculate',
            'get_weather',
            'remember',
            'recall'
          ]
          maxSteps = 20
          searchTool = wrapSearchToolForSources(
            wrapSearchToolWithDedup(
              wrapSearchToolForQuickMode(originalSearchTool),
              seenUrls,
              seenQueries
            ),
            sources
          )
          break

        case 'quality':
          systemPrompt = getQualityModePrompt()
          activeToolsList = [
            'search',
            'fetch',
            'todoWrite',
            'calculate',
            'get_weather',
            'remember',
            'recall'
          ]
          console.log(
            `[Researcher] Quality mode: maxSteps=100, tools=[${activeToolsList.join(', ')}], sources=${JSON.stringify(sources)}`
          )
          maxSteps = 100
          searchTool = wrapSearchToolForSources(
            wrapSearchToolWithDedup(originalSearchTool, seenUrls, seenQueries),
            sources
          )
          break

        case 'balanced':
        default:
          systemPrompt = getAdaptiveModePrompt()
          activeToolsList = [
            'search',
            'fetch',
            'todoWrite',
            'calculate',
            'get_weather',
            'remember',
            'recall'
          ]
          console.log(
            `[Researcher] Balanced mode: maxSteps=50, tools=[${activeToolsList.join(', ')}], sources=${JSON.stringify(sources)}`
          )
          maxSteps = 50
          searchTool = wrapSearchToolForSources(
            wrapSearchToolWithDedup(originalSearchTool, seenUrls, seenQueries),
            sources
          )
          break
      }

      // Append source instructions to system prompt
      systemPrompt = systemPrompt + getSourcesPromptAddendum(sources)
    }

    // Offer image generation across every mode (skip/speed/quality/balanced)
    // when it's configured AND the turn has an authenticated user — generated
    // images are persisted into that user's upload store, and
    // createGenerateImageTool requires a userId, so ephemeral/no-user turns
    // (create-ephemeral-chat-stream-response.ts) don't get the tool.
    const imageGenAvailable = isImageGenEnabled() && Boolean(userId)
    if (imageGenAvailable) {
      activeToolsList.push('generateImage')
    }

    // Give the agent the classifier's resolved standalone query as a
    // scoping hint alongside the raw conversation — Perplexica's pattern.
    // It's a hint, not a rigid replacement: the agent can still exercise
    // judgment (e.g. broaden the search) on top of it. Applied in skip
    // mode too, where it doubles as the resolved reading of the user's
    // latest message (useful if the escape-hatch search fires).
    if (standaloneQuery) {
      systemPrompt =
        systemPrompt +
        `\n\n## Scope of this turn

Resolved form of the user's latest message: "${standaloneQuery}"

**This resolved query is the ENTIRE scope of this turn — for searching AND for answering.**

The conversation history is background context, not a to-do list. Any topic from an earlier turn has already been answered and is NOT outstanding work:
- Answer ONLY this resolved query. Do NOT re-address, re-diagnose, revisit, or add an "update" section about an earlier topic unless this resolved query itself asks about it.
- If you search, search only for this resolved query — never for topics from earlier turns.
- The user switching to a new topic is normal and complete on its own. An abrupt change of subject is NOT a request to also continue the previous one, and is NOT the user "appending" a second question to an older one — treat the resolved query above as the whole of what was asked.
- Your answer must address exactly one thing: the resolved query. If you catch yourself planning to cover two topics because the earlier one is still in the history, that is this rule being violated — drop the earlier one.`
    }

    // Append user's custom instructions at lower priority (per Vane pattern)
    if (systemInstructions?.trim()) {
      systemPrompt =
        systemPrompt +
        `\n\n### User instructions\nThese instructions are provided by the user. Follow them but give them lower priority than the above system guidelines.\n${systemInstructions.trim()}`
    }

    // Inject the user's confirmed long-term memories, if any (fail-safe:
    // resolves to '' for ephemeral/incognito chats, disabled memory, or on
    // any failure — never blocks or throws).
    const memoryBlock = await getMemoryInjection(userId)
    if (memoryBlock) systemPrompt = systemPrompt + memoryBlock

    if (recallBlock) systemPrompt = systemPrompt + recallBlock

    // Teach the agent when/how to reach for generateImage — but only when the
    // tool is actually registered (same gate as activeToolsList and the tools
    // object below). Appending guidance for an unregistered tool would prompt
    // the model to hallucinate calls to a tool that isn't available.
    if (isImageGenEnabled() && userId) {
      systemPrompt = systemPrompt + IMAGE_TOOL_GUIDANCE
    }

    // Build tools object with proper typing
    const tools: ResearcherTools = {
      search: searchTool,
      fetch: fetchTool,
      askQuestion: askQuestionTool,
      calculate: calculateTool,
      get_weather: weatherTool,
      remember: createRememberTool(userId),
      recall: createRecallTool(userId, currentChatId),
      // Gated identically to the activeToolsList entry above so the two never
      // disagree. `&& userId` also narrows userId to string for the tool's
      // required first argument.
      ...(isImageGenEnabled() &&
        userId && {
          generateImage: createGenerateImageTool(userId, currentChatId)
        }),
      ...todoTools
    } as ResearcherTools

    // PIPELINE: await the retrieval that started at t=0, fold the sources into
    // the prompt, and take `search` away. Awaiting HERE rather than at the call
    // site is what let it overlap the classifier and recall — by this point it
    // has usually already resolved, so the wait is near zero.
    let pipelineSourceBlock = ''
    // How many sources the awaited retrieval returned, or null when this turn
    // declined sources and never awaited it. Drives the last-resort `search`
    // provisioning below, which must distinguish "asked and got nothing" from
    // "never asked".
    let sourcesRetrieved: number | null = null
    if (pipelineRetrievalPromise) {
      // Retrieval is now CONDITIONAL on the classifier, not unconditional.
      //
      // `skipSearch` covers turns answerable from the conversation itself.
      // `needsRecent` covers freshness and `needsSources` covers grounding —
      // either one is enough to keep the sources. A turn that is none of the
      // three (pure arithmetic, an image request, small talk) answers directly.
      //
      // needsSources was added because gating on freshness alone inverted the
      // saving: settled-knowledge questions were declined, and the last-resort
      // rule then handed them `search` anyway, turning a saved source block
      // into an extra model round trip.
      if (!shouldInjectRetrieval({ skipSearch, needsRecent, needsSources })) {
        // The classifier says this turn is answerable from the conversation
        // itself. Retrieval already FIRED — it starts at t=0, before the
        // classifier returns — so the search is spent either way. What is
        // saved here is the context, which is the part that costs: turn
        // latency tracks prompt_tokens at r=0.76, and a source block is ~9.6k
        // tokens the model would otherwise read for nothing.
        //
        // Discarding rather than not-firing is the deliberate trade. Waiting
        // for the classifier before retrieving would put ~1.2s of classify
        // back on the critical path for EVERY turn, to save a parallel search
        // on a minority of them.
        console.log(
          '[pipeline] skipSearch — retrieval discarded, no sources injected'
        )
      } else {
        const retrieval = await pipelineRetrievalPromise
        pipelineSourceBlock = `\n\n${buildSourceBlock(retrieval)}`
        sourcesRetrieved = retrieval.results?.results?.length ?? 0
        console.log(
          `[pipeline] ${sourcesRetrieved} sources injected (retrieval took ${retrieval.ms}ms)`
        )
      }
    }

    // Control-flow variant (lib/agents/flows). `baseline` is a no-op and is
    // the control arm; every other variant reshapes the loop itself rather
    // than tuning it. See flows/types.ts for what a variant may and may not do.
    const flow = resolveFlowVariant(process.env.FLOW_VARIANT)
    const flowPrompt = flow.buildPrompt?.({
      basePrompt: systemPrompt,
      searchMode,
      skipSearch,
      hasUrl: false
    })
    // SYSTEM-DRIVEN TOOL PROVISIONING — pipeline turns only.
    //
    // The loop path keeps its mode-based tool list untouched below. Here the
    // SYSTEM reads the turn and hands the model exactly the capabilities it
    // needs, with a step ceiling derived from that same list, so the shape of a
    // turn stops being a property of whichever model is selected. Enforcement
    // is `activeTools`, which the SDK applies before any provider sees the
    // request — it holds for every model, unlike a prompt or toolChoice.
    //
    // The previous rule here (strip `search` and `fetch` when sources were
    // injected, otherwise leave all nine tools and a ceiling of 50) is what
    // this replaces. It left the two cases inverted: the turn that had sources
    // was constrained, and the turn that had none — where the model has the
    // most room to wander — kept every tool and every step.
    const provisioning = pipelineRetrievalPromise
      ? provisionTurnTools({
          // standaloneQuery is the fallback, not the input: it is the
          // classifier's REWRITE, and a rewrite can drop the URL or the
          // expression that is the whole cue.
          message: latestMessageText ?? standaloneQuery ?? '',
          intent,
          skipSearch,
          needsRecent,
          needsSources,
          imageGenAvailable,
          sourcesRetrieved
        })
      : undefined

    const effectiveSystemPrompt =
      (flowPrompt ?? systemPrompt) +
      // Before the sources, so the retrieved block stays last in the prompt.
      (provisioning ? buildProvisionedToolsNote(provisioning.tools) : '') +
      pipelineSourceBlock

    // Typed as the tool map's keys so a provisioned name that is not a
    // registered tool is a compile error rather than a silently ignored entry.
    const effectiveActiveTools: (keyof ResearcherTools)[] = provisioning
      ? provisioning.tools
      : activeToolsList
    // On a pipeline turn the cap comes from the SAME call that chose the tools
    // — a variant's ceiling would reintroduce exactly the disagreement between
    // the two that this function exists to make impossible.
    const effectiveMaxSteps = provisioning
      ? provisioning.maxSteps
      : (flow.maxSteps ?? maxSteps)

    if (provisioning) {
      console.log(
        `[pipeline] provisioned tools=[${provisioning.tools.join(', ')}] maxSteps=${provisioning.maxSteps} — ${provisioning.reason}`
      )
    }
    if (flow.id !== 'baseline') {
      console.log(
        `[flow] variant=${flow.id} maxSteps=${effectiveMaxSteps} (${flow.summary})`
      )
    }

    // WITHHOLD unprovisioned tools from the MAP, not just from activeTools.
    //
    // activeTools is advertising only: the SDK consults it in
    // prepareToolsAndToolChoice to decide which definitions reach the provider,
    // then executes whatever comes back via `tools[toolCall.toolName]` against
    // the FULL map. Measured on probe p09 — kimi-k2.6 called `search` on a turn
    // where activeTools was empty and the SDK ran it, burning the turn's only
    // step and returning zero characters.
    //
    // Removing the entry makes that call unexecutable rather than merely
    // unhelpful, which is worth ~20-40s: a stray `search` that RUNS costs a full
    // retrieval before achieving nothing. Verified safe rather than assumed —
    // an unknown tool name does NOT throw out of the turn. The SDK catches it
    // and returns a tool-call marked `dynamic: true, invalid: true, error`, so
    // the loop continues and the reserved final step still writes the answer.
    // (An empty map is also fine: prepareToolsAndToolChoice sends no tools at
    // all when the map is empty, so there is nothing left to hallucinate.)
    // The cast is a deliberate narrowing, not a papering-over. ResearcherTools
    // names every tool the researcher CAN register, and the point here is to
    // hand over fewer than that — a partial map is the intent. It is safe
    // because nothing downstream enumerates the type's keys: the SDK only ever
    // does `tools[name]` lookups and `Object.entries(tools)`, both of which are
    // correct on a smaller object. `activeTools` is still typed against the full
    // key union, which is what keeps a typo caught at compile time.
    const effectiveTools = provisioning
      ? (Object.fromEntries(
          provisioning.tools
            .map(name => [name, tools[name]] as const)
            .filter(([, impl]) => impl != null)
        ) as unknown as ResearcherTools)
      : tools

    // Create ToolLoopAgent with all configuration
    const agent = new ToolLoopAgent({
      model: getModel(model, abortSignal),
      instructions: `${effectiveSystemPrompt}\nCurrent date and time: ${currentDate}`,
      tools: effectiveTools,
      activeTools: effectiveActiveTools,
      // Per-step control. The SDK calls this before EVERY step including the
      // first, which is what lets a variant force step 0 (plan-execute forces
      // todoWrite, wide-once forces search) or strip tools afterwards.
      //
      // The single `as never` is deliberate and contained. The SDK types
      // prepareStep against the researcher's concrete tool map, narrowing
      // toolName to a literal union; a tool-agnostic variant registry cannot
      // express that union without depending on the tool map, which is the
      // coupling this indirection exists to avoid. Narrowing happens here, at
      // one call site, rather than leaking SDK generics into every variant.
      // Wired whenever EITHER a variant wants per-step control or a pipeline
      // turn needs its answer step reserved.
      //
      // The `flow.prepareStep &&` condition used to be the whole guard, and it
      // is why the previous attempt to fix the empty-answer bug appeared to
      // fail: the lab runs FLOW_VARIANT=baseline, baseline defines no
      // prepareStep, so the spread evaluated to `{}` and the hook never
      // reached the SDK. The failing run's own numbers show it — those turns
      // still made a tool call on their second step, which cannot happen if
      // activeTools had been emptied there. See applyAnswerStepReserve.
      ...((flow.prepareStep || provisioning) && {
        prepareStep: (({ stepNumber, steps }: FlowStepArgs) => {
          const variant: FlowStepOverrides = flow.prepareStep
            ? flow.prepareStep({
                stepNumber,
                steps: steps as readonly FlowStep[],
                skipSearch
              })
            : {}
          // Applied AFTER the variant so it wins: a variant tuning which tools
          // are visible mid-loop is a preference, and having a step left to
          // write the answer in is not.
          const o = provisioning
            ? applyAnswerStepReserve(variant, {
                stepNumber,
                maxSteps: effectiveMaxSteps,
                systemPrompt: effectiveSystemPrompt
              })
            : variant
          if (provisioning) {
            // The reserve was believed once already to have been tried and
            // failed, on the strength of an aggregate that never distinguished
            // "fired and did not help" from "never ran". One line per step
            // makes that unmistakable in the logs.
            console.log(
              `[pipeline] step ${stepNumber}/${effectiveMaxSteps - 1}: activeTools=[${(o.activeTools ?? provisioning.tools).join(', ')}]${o.system ? ' +final-step-note' : ''}`
            )
          }
          // A `system` override REPLACES the instructions for that step, so the
          // date has to be re-appended — whoever produced the override — or the
          // model silently loses it partway through a turn.
          return (
            o.system
              ? {
                  ...o,
                  system: `${o.system}\nCurrent date and time: ${currentDate}`
                }
              : o
          ) as never
        }) as never
      }),
      // No toolChoice forcing by default and no dedicated "done" tool —
      // matches upstream Morphic's proven pattern. The loop stops the moment
      // the model responds with plain text and no tool calls; forcing a tool
      // call on every step (as a prior version did) left weaker models with no
      // valid way to finish except an unfamiliar "stop" tool, so they looped
      // on search/fetch instead of ever answering. Variants that DO force a
      // step do it for one specific step, never for all of them.
      //
      // stepCountIs compares with strict equality, so a variant's extra
      // condition is listed alongside it rather than folded into it.
      stopWhen: flow.shouldStop
        ? ([
            stepCountIs(effectiveMaxSteps),
            (({ steps }: FlowStopArgs) =>
              flow.shouldStop!(steps as readonly FlowStep[])) as never
          ] as never)
        : stepCountIs(effectiveMaxSteps),
      ...(modelConfig?.providerOptions && {
        providerOptions: modelConfig.providerOptions
      }),
      experimental_telemetry: {
        isEnabled: isTracingEnabled(),
        functionId: 'research-agent',
        metadata: {
          modelId: model,
          agentType: 'researcher',
          searchMode,
          skipSearch,
          flowVariant: flow.id,
          ...(parentTraceId && {
            langfuseTraceId: parentTraceId,
            langfuseUpdateParent: false
          })
        }
      }
    })

    return agent
  } catch (error) {
    console.error('Error in createResearcher:', error)
    throw error
  }
}

// Helper function to access agent tools
export function getResearcherTools(
  agent: ToolLoopAgent<never, ResearcherTools, never>
): ResearcherTools {
  return agent.tools
}

// Export the legacy function name for backward compatibility
export const researcher = createResearcher
