import type { FlowStep } from './flows/types'

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

import { resolveFlowVariant } from './flows/variants'
import { IMAGE_TOOL_GUIDANCE } from './prompts/image-tool-guidance'
import {
  getAdaptiveModePrompt,
  getQualityModePrompt,
  SPEED_MODE_PROMPT
} from './prompts/search-mode-prompts'
import {
  ANSWER_DEADLINE_MS,
  ANSWER_NOW_DIRECTIVE,
  retrievalBudgetSpent
} from './turn-budget'

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

// Short-circuits a retrieval tool once the turn's budget is spent.
//
// The prepareStep deadline alone is NOT enough: prepareStep runs only BETWEEN
// steps, so a single step whose tool calls run long blows the budget without
// the check ever executing.
//
// KNOWN INSUFFICIENT — this bounds tools only, and tools are not where the
// time goes. Reconstructed from lab Postgres across nine runs of the
// current-events conversation, the dominant cost is the MODEL call: one
// failing step spanned 268.5s containing a single `fetch`, which is
// structurally capped near 45s (FETCH_MAX_URLS=5, 40s each). ~225s of it was
// the model. Nothing here or in prepareStep bounds that.
//
// Second known gap: the deadline is only armed while awaiting a chunk. Once
// this generator parks at `yield`, no timer is live — and fetchTool yields
// {state:'fetching'} before doing any work, so the wrapper parks immediately.
// A real fix needs one absolute timer armed at turn start that aborts the
// in-flight model call, not a per-chunk race.
function wrapToolWithBudget<T extends { execute?: unknown }>(
  originalTool: T,
  toolName: string,
  startedAtMs: number
): T {
  const t = originalTool as unknown as {
    description: string
    inputSchema: unknown
    toModelOutput?: unknown
    execute?: (params: unknown, context: unknown) => unknown
  }
  return tool({
    description: t.description,

    inputSchema: t.inputSchema as any,

    toModelOutput: t.toModelOutput as any,

    async *execute(params: any, context: any) {
      const emptyResult = (reason: string) => {
        console.log(
          `[budget] ${toolName} ${reason} after ${Math.round((Date.now() - startedAtMs) / 1000)}s`
        )
        // Shaped like a normal empty result so the model treats it as "this
        // search found nothing" rather than an error worth retrying.
        return {
          state: 'complete' as const,
          results: [],
          images: [],
          query: (params as { query?: string })?.query ?? '',
          number_of_results: 0,
          budgetExhausted: true
        }
      }

      if (retrievalBudgetSpent(startedAtMs)) {
        yield emptyResult('skipped — budget already spent')
        return
      }

      const executeFunc = t.execute
      if (!executeFunc) throw new Error(`${toolName} execute is not defined`)
      const result = executeFunc(params, context)
      const iterable =
        result &&
        typeof result === 'object' &&
        Symbol.asyncIterator in (result as object)
          ? (result as AsyncIterable<unknown>)
          : (async function* () {
              yield await result
            })()

      // Checking only at tool START is not enough either: a call that BEGINS
      // before the deadline and then runs long consumes the budget from inside
      // an execution already in flight. Racing each chunk bounds a slow host —
      // but only while a chunk is actually being awaited (see the note above).
      const iterator = iterable[Symbol.asyncIterator]()
      const EXPIRED = Symbol('expired')
      let timer: ReturnType<typeof setTimeout> | undefined
      // The SDK treats the LAST yielded value as the tool's output, and the
      // advanced-search path yields a preview chunk carrying real results
      // before its final one. Yielding a synthetic empty on cutoff therefore
      // THREW AWAY sources the call had already paid for — the opposite of
      // this module's whole premise. Keep the best chunk seen and hand that
      // back instead, falling back to empty only if nothing arrived.
      let lastNonEmpty: unknown
      const cutOff = () => {
        if (lastNonEmpty) {
          console.log(
            `[budget] ${toolName} cut off after ${Math.round((Date.now() - startedAtMs) / 1000)}s — keeping partial results`
          )
          return { ...(lastNonEmpty as object), budgetExhausted: true }
        }
        return emptyResult('cut off mid-execution — budget spent')
      }
      try {
        for (;;) {
          const remaining = ANSWER_DEADLINE_MS - (Date.now() - startedAtMs)
          if (remaining <= 0) {
            yield cutOff()
            return
          }
          const expiry = new Promise<typeof EXPIRED>(resolve => {
            timer = setTimeout(() => resolve(EXPIRED), remaining)
          })
          const next = await Promise.race([iterator.next(), expiry])
          if (timer) clearTimeout(timer)
          if (next === EXPIRED) {
            yield cutOff()
            return
          }
          if (next.done) return
          const chunk = next.value as { results?: unknown[] }
          if (Array.isArray(chunk?.results) && chunk.results.length > 0) {
            lastNonEmpty = next.value
          }
          yield next.value
        }
      } finally {
        if (timer) clearTimeout(timer)
        // Propagate cleanup inward. Without this, a consumer that abandons the
        // wrapper mid-stream leaves the inner generator suspended forever and
        // its own `finally` never runs. Not awaited: a queued return() is only
        // honoured at the inner generator's next yield point, so awaiting it
        // would block for the full remaining work rather than shedding it.
        void iterator.return?.(undefined)
      }
    }
  }) as unknown as T
}

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
  // Route-entry timestamp, NOT the time this function was called. The
  // retrieval budget must share an origin with the route's hard abort, and
  // everything between the two — body parse, auth, message conversion, the
  // context-window probe, the classifier await and the recall await — runs
  // before this point.
  //
  // Measured: taking the start here put the deadline at 293s of route time
  // instead of 210s, leaving ~7s to write instead of 90s, and turns still died
  // at the 300s abort with nothing persisted. An 83s preamble is not
  // exceptional on a cold model.
  turnStartedAt
}: {
  model: string
  turnStartedAt?: number
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
    if (isImageGenEnabled() && userId) {
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
    // Falls back to now only if the caller did not supply the route-entry
    // time; that path measures a shorter budget than intended but never a
    // longer one, so it degrades safely.
    const budgetStartedAt = turnStartedAt ?? Date.now()

    const tools: ResearcherTools = {
      // search and fetch are the only tools that can burn the budget — they
      // reach the network and, on a bad candidate pool, grind through failing
      // hosts. calculate/recall/weather are bounded and local, so wrapping
      // them would add indirection for nothing.
      search: wrapToolWithBudget(searchTool, 'search', budgetStartedAt),
      fetch: wrapToolWithBudget(fetchTool, 'fetch', budgetStartedAt),
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
    const effectiveSystemPrompt = flowPrompt ?? systemPrompt
    const effectiveMaxSteps = flow.maxSteps ?? maxSteps
    if (flow.id !== 'baseline') {
      console.log(
        `[flow] variant=${flow.id} maxSteps=${effectiveMaxSteps} (${flow.summary})`
      )
    }

    // Create ToolLoopAgent with all configuration
    const agent = new ToolLoopAgent({
      model: getModel(model, abortSignal),
      instructions: `${effectiveSystemPrompt}\nCurrent date and time: ${currentDate}`,
      tools,
      activeTools: activeToolsList,
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
      // ALWAYS set, even for variants with no prepareStep of their own, because
      // the retrieval deadline below is a safety net that every variant needs.
      prepareStep: (({ stepNumber, steps }: FlowStepArgs) => {
        // Deadline first, and it overrides the variant. Once the budget is
        // spent the only acceptable next step is prose, so a variant that would
        // force another tool here must not win — that is exactly the path that
        // produced turns ending at 300s with nothing written.
        if (retrievalBudgetSpent(budgetStartedAt)) {
          // Logged unconditionally: a turn hitting this is already anomalous,
          // and without the line there is no way to tell "the deadline fired
          // and the answer was still slow" from "the deadline never fired",
          // which are opposite bugs with the same symptom.
          console.log(
            `[budget] retrieval deadline hit at step ${stepNumber} after ${Math.round((Date.now() - budgetStartedAt) / 1000)}s — forcing answer`
          )
          return {
            // `activeTools: []` is the load-bearing half. `toolChoice: 'none'`
            // is NOT honoured by this deployment's default provider —
            // ai-sdk-ollama's getCallOptions never destructures toolChoice and
            // emits no warning, so the SDK computes it correctly and the
            // provider silently drops it. The default model is Ollama-backed,
            // so on its own this override did nothing at all and the loop kept
            // calling tools straight through the deadline.
            //
            // activeTools is applied by the SDK BEFORE the provider is
            // involved — prepareToolsAndToolChoice filters by name and sends
            // an empty tool list — so it holds regardless of provider support.
            // toolChoice stays for providers that do respect it.
            activeTools: [],
            toolChoice: 'none',
            system: `${effectiveSystemPrompt}\n\n${ANSWER_NOW_DIRECTIVE}\nCurrent date and time: ${currentDate}`
          } as never
        }

        if (!flow.prepareStep) return {} as never

        const o = flow.prepareStep({
          stepNumber,
          steps: steps as readonly FlowStep[],
          skipSearch
        })
        // A variant's `system` REPLACES the instructions for that step, so
        // the date has to be re-appended or the model silently loses it
        // partway through a turn.
        return (
          o.system
            ? {
                ...o,
                system: `${o.system}\nCurrent date and time: ${currentDate}`
              }
            : o
        ) as never
      }) as never,
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
