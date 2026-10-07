import type { FlowStep, FlowStepOverrides } from './flows/types'

// Structural shapes for the two SDK callbacks, so the casts above stay
// narrow and readable rather than `any`.
type FlowStepArgs = {
  stepNumber: number
  steps: readonly unknown[]
  // The step's input messages as the SDK built them (the turn's messages plus
  // this turn's responses so far). Returning a `messages` override replaces
  // them for this step only.
  messages?: readonly unknown[]
}
type FlowStopArgs = { steps: readonly unknown[] }
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { stepCountIs, tool, ToolLoopAgent } from 'ai'

import type { ResearcherTools } from '@/lib/types/agent'
import { type Model } from '@/lib/types/models'

import { getMemoryInjection } from '../memory/inject'
import { getRelatedQuestionsSpecPrompt } from '../render/prompt'
import type { FullContentByToolCall } from '../search/rehydrate-full-content'
import { calculateTool } from '../tools/calculate'
import { createFetchTool } from '../tools/fetch'
import {
  createGenerateImageTool,
  isImageGenEnabled
} from '../tools/generate-image'
import { createQuestionTool } from '../tools/question'
import { createRecallTool } from '../tools/recall'
import { createRememberTool } from '../tools/remember'
import { createSearchTool } from '../tools/search'
import {
  resolveSearchRoundsBudget,
  type SearchRoundCounter
} from '../tools/search-rounds'
import { createTodoTools } from '../tools/todo'
import { weatherTool } from '../tools/weather'
import { SearchMode, SearchSources } from '../types/search'
import { isCitationHandlesEnabled } from '../utils/citation-handles'
import { getModel } from '../utils/registry'
import { isTracingEnabled } from '../utils/telemetry'

import { resolveFlowVariant } from './flows/variants'
import { IMAGE_TOOL_GUIDANCE } from './prompts/image-tool-guidance'
import {
  getAdaptiveModePrompt,
  getQualityModePrompt,
  getQuickModePrompt,
  UNTRUSTED_CONTENT_RULE
} from './prompts/search-mode-prompts'
import {
  buildForcedSearchInput,
  createForcedSearchModel,
  getForcedSearchPromptAddendum,
  isAlwaysSearchEnabled,
  resolveForcedSearchQuery,
  type UserSuppliedSource
} from './always-search'
import {
  ANSWER_DEADLINE_MS,
  applyAnswerDeadline,
  enforceAnswerDeadline
} from './answer-deadline'
import { createAnswerStepReminderModel } from './answer-step-reminder'
import {
  countCitableToolCalls,
  getCitationReminderText,
  resolveCitationReminderMode,
  withCitationReminder
} from './citation-reminder'
import {
  answerNowAfterPostCapToolSteps,
  answerNowOnSearchEvasion,
  resolvePostCapToolStepsLimit,
  resolveSearchWithdrawnNote,
  searchBudgetSpent,
  type SearchCapStep,
  toolStepsAfterWithdrawal,
  withdrawSearchAfterCap,
  withSearchWithdrawnNote
} from './search-cap'

// The pasted-URL branch fills a source's title from the fetched page's <title>,
// which is attacker-controlled when the user pastes a hostile link. That title
// is interpolated verbatim into the SYSTEM prompt (a more privileged position
// than tool-message content), so a title carrying newlines, quotes, or
// backticks could break out of its `"..."` wrapper and inject system-level
// instructions. Neutralize it before interpolation: flatten every control char
// to a space so nothing spans lines, drop the delimiters it could exploit,
// collapse whitespace, and clip. Pure + exported so it can be unit-tested.
const MAX_SOURCE_TITLE_CHARS = 200

export function sanitizeSourceTitle(title: unknown): string {
  const cleaned = String(title ?? '')
    // Control chars (incl. newlines, tabs, CR, DEL) → a single space so the
    // title can never break onto a new prompt line.
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    // Backticks and double-quotes could close the `"..."` wrapper: drop the
    // backtick outright, soften the double-quote to a single quote.
    .replace(/`/g, '')
    .replace(/"/g, "'")
    // Collapse any whitespace runs the control-char pass introduced, then trim.
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return 'attached source'
  return cleaned.length > MAX_SOURCE_TITLE_CHARS
    ? cleaned.slice(0, MAX_SOURCE_TITLE_CHARS) + '…'
    : cleaned
}

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
  - If, while answering, you realize a needed fact is NOT actually established above (or what's above may be stale for a time-sensitive claim), run the \`search\` tool rather than guessing from memory. If you do search, cite what you use (only the toolCallId of a \`search\` or \`fetch\` call you actually made this turn; never compose an anchor yourself).
  - If the reply requires arithmetic on numbers from the conversation (recompute, totals, unit conversions), use \`calculate\` instead of doing mental math.
  - If the user asks you to re-quote or re-check a page already linked in this conversation, you may \`fetch\` that URL.
- Do not add citations when you used no tools — you're restating what was already discussed.
- Format as Markdown. A heading is optional: use one only if it genuinely helps organize a longer answer; for a short confirmation or clarification, plain prose is fine.
- ALWAYS respond in the user's language.

${getRelatedQuestionsSpecPrompt()}
`

// Sibling of DIRECT_ANSWER_PROMPT for a DIFFERENT situation, and the two must
// not be merged. That one says "answerable from what has already been
// established in this conversation" — true for a follow-up, false and actively
// misleading for a brand-new question like "explain closures in JavaScript",
// where the conversation contains no answer to draw on. Same structure and
// same escape-hatch shape, different premise.
//
// WHY THIS EXISTS. A blind pairwise judge over 46 turns compared this
// architecture against one that declines to retrieve on stable-knowledge
// questions. On the 18 turns where this one searched and the other did not,
// the other won 13-2. The cost of searching a settled question is not just
// latency: the answer comes back padded with citations to introductory pages
// and reads worse. The same run also showed the opposite where retrieval
// genuinely matters (4-8 against, on turns where both searched), which is why
// only the decision is ported here and not the architecture around it.
//
// Search stays IN the tool map rather than being withheld. Withholding is
// strictly stronger — activeTools alone is advertising, not enforcement — but
// this gate fires on a model's judgement about a live user's question, and the
// failure mode of a wrong `false` is an ungrounded answer with no way back. The
// escape hatch below is the same one skipSearch has relied on in production.
const STABLE_KNOWLEDGE_PROMPT = `Instructions:

Answer the user's question directly, from your own knowledge. This question was assessed as one a well-read expert can answer reliably without consulting sources — a concept, a definition, how something works, established science or history, general programming knowledge, mathematics, or a matter of judgement.

- Do NOT search the web. A solid answer written from knowledge you already have is better than the same answer padded with citations to introductory pages.
- Escape hatch — you still have tools, use one ONLY if actually required to answer correctly:
  - If answering turns out to depend on a specific current fact you cannot state reliably — a version number, a price, a date, a statistic, a release note, or a claim about a specific named product or paper — run the \`search\` tool rather than guessing. If you do search, cite what you use (only the toolCallId of a \`search\` or \`fetch\` call you actually made this turn; never compose an anchor yourself).
  - If the reply requires arithmetic, use \`calculate\` instead of doing mental math.
- Do not add citations when you used no tools, and do not apologise for not searching or mention that you did not search. Just answer.
- Be substantive: this is a full answer to a real question, not a summary. Cover the question properly.
- Format as Markdown. Use headings only if they genuinely help organize a longer answer.
- ALWAYS respond in the user's language.

${getRelatedQuestionsSpecPrompt()}
`

/**
 * Which of the three prompt/tool configurations this turn gets.
 *
 * Extracted as a pure function because it is the whole of the new behaviour
 * and the rest of createResearcher is not reachable from a test — the agent
 * keeps `instructions` and `activeTools` private, so the branch is otherwise
 * unobservable. Ordering and the two-flag rule live here so both can be
 * asserted directly.
 */
export type TurnMode = 'direct' | 'stable-knowledge' | 'research'

export function resolveTurnMode({
  skipSearch = false,
  needsSources = true,
  needsRecent = false,
  // ALWAYS_SEARCH (lib/agents/always-search.ts). Defaults to the flag's own
  // default, ON; createResearcher passes the live env value.
  alwaysSearch = true
}: {
  skipSearch?: boolean
  needsSources?: boolean
  needsRecent?: boolean
  alwaysSearch?: boolean
}): TurnMode {
  // FIRST, and deliberately: "the conversation already answers this" is a
  // stronger claim than "general knowledge answers this", and it comes with a
  // prompt that reads the conversation rather than ignoring it. Under
  // ALWAYS_SEARCH the classifier sets skipSearch ONLY for non-questions
  // (greeting/thanks, a pure transform of text already present, pure
  // arithmetic, an image request, an explicit remember/forget instruction),
  // so this is the one remaining skip.
  if (skipSearch) return 'direct'
  // ALWAYS_SEARCH reverses decision D3 (owner, 2026-09-26): every question is
  // a research turn, so needsSources no longer gates anything. Prod evidence:
  // 47 of 164 turns over 60 days were routed here as sourceless and answered
  // from memory — named products, company policies, home repair, health and
  // safety — e.g. a melted-plastic answer that recommended acetone with no
  // fire warning.
  if (alwaysSearch) return 'research'
  // Legacy D3 gate (ALWAYS_SEARCH=off). BOTH flags. They are independent —
  // freshness versus whether sources help at all — and needsRecent=true is an
  // explicit statement that the answer decays with time, which parametric
  // knowledge cannot serve however well-established the topic is.
  if (!needsSources && !needsRecent) return 'stable-knowledge'
  return 'research'
}

/**
 * The query this turn's first step is forced to search, or null when the turn
 * is not forced. Forced only for a research turn with ALWAYS_SEARCH on, when
 * the user did not supply the subject themselves (a URL, or an attachment the
 * text only points at — see detectUserSuppliedSource) and something
 * searchable remains in the resolved query (resolveForcedSearchQuery). Pure
 * and exported so the decision is testable apart from the agent, which keeps
 * its prepareStep private.
 */
export function resolveForcedFirstSearch({
  alwaysSearch,
  turnMode,
  standaloneQuery,
  userSuppliedSource = null
}: {
  alwaysSearch: boolean
  turnMode: TurnMode
  standaloneQuery?: string
  userSuppliedSource?: UserSuppliedSource | null
}): string | null {
  if (!alwaysSearch || turnMode !== 'research') return null
  // The user handed over the source: the turn stays research (search is still
  // advertised and the model may use it) but is not made to search first —
  // exactly how a URL turn behaved before ALWAYS_SEARCH.
  if (userSuppliedSource) return null
  return resolveForcedSearchQuery(standaloneQuery)
}

/**
 * What createResearcher decided for this turn, reported for telemetry.
 * `forcedSkip` is set only on an ALWAYS_SEARCH research turn whose first step
 * was not forced because the user supplied the source.
 */
export type TurnPlan = {
  turnMode: TurnMode
  forcedSearch: boolean
  forcedSkip?: UserSuppliedSource
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
  // Synthetic `documentRetrieval` tool calls injected for attached documents /
  // pasted URLs this turn (see create-chat-stream-response.ts). Each entry names
  // a REAL toolCallId whose results the model may cite. Without a prompt clause
  // naming these ids, the citation-integrity rule below silently discards the
  // anchor (SPIKE finding #1), so the retrieved chunks would be uncitable.
  documentRetrievalSources,
  // Folds each search/fetch call's stage timings into the per-turn [latency]
  // line (create-chat-stream-response owns the LatencyTracker). Additive
  // telemetry only; undefined (e.g. ephemeral turns) leaves the tools untimed.
  onToolTiming,
  // ALWAYS_SEARCH override for tests; production reads the env flag.
  alwaysSearch = isAlwaysSearchEnabled(),
  // Set by the caller from the latest user message's parts
  // (detectUserSuppliedSource): a URL or an attachment the user supplied as
  // the subject. Cancels the forced first search; changes nothing else.
  userSuppliedSource = null,
  // Reports the resolved turn mode and whether step 0 is a forced search, so
  // the [latency] line can carry turn_mode / forced_search. Telemetry only.
  onTurnPlan
}: {
  model: string
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
  // Set by the query classifier when the answer turns on specifics that
  // cannot be stated reliably from memory. False routes the turn to
  // STABLE_KNOWLEDGE_PROMPT instead of the search-mode prompt.
  //
  // DEFAULTS TRUE, and that default is the safety property: every existing
  // caller that does not pass this keeps searching exactly as before, so the
  // gate can only ever engage where the classifier deliberately said no.
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
  // Attached-source retrievals injected this turn — each a citable toolCallId +
  // its display title. Empty/undefined leaves the citation rules untouched.
  documentRetrievalSources?: { toolCallId: string; title: string }[]
  // Reports a completed search/fetch call's stage durations (ms) so the
  // per-turn [latency] line can accumulate them. Additive telemetry only.
  onToolTiming?: (
    kind: 'search' | 'fetch',
    stages: Record<string, number>
  ) => void
  alwaysSearch?: boolean
  userSuppliedSource?: UserSuppliedSource | null
  onTurnPlan?: (plan: TurnPlan) => void
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

    // This turn's search rounds, counted by the search tool itself (only
    // searches that actually run) and read by prepareStep below, which stops
    // offering `search` once the budget is spent (lib/agents/search-cap.ts).
    const searchRounds: SearchRoundCounter = { used: 0 }

    // Create model-specific tools with proper typing
    const originalSearchTool = createSearchTool(model, {
      timeRange: needsRecent ? 'month' : undefined,
      expandedQueries: expandedQueriesPromise,
      intent,
      // Lets the search tool take the speed-mode fast path (answer from
      // Ollama-web full page bodies, no crawl) without inferring the tier from
      // firstSearchDepth — which is also 'basic' for skip and exclusive-source
      // turns, so it cannot stand in for 'speed'.
      searchMode,
      firstSearchDepth,
      chatId: currentChatId,
      fullContentSink,
      onToolTiming,
      searchRounds
    })
    // Per-request fetch instance so this turn's fetch calls report their wall
    // time into the same tracker. Untimed default instance stays for url-rag.
    // searchMode selects the per-turn fetch cap (lib/tools/fetch-budget.ts).
    const fetchTool = createFetchTool({
      onToolTiming,
      searchMode,
      chatId: currentChatId
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

    const turnMode = resolveTurnMode({
      skipSearch,
      needsSources,
      needsRecent,
      alwaysSearch
    })
    // ALWAYS_SEARCH: step 0 of a research turn IS a web search, performed by
    // a synthetic model that emits one `search` call (see
    // createForcedSearchModel for why not toolChoice). null = not forced.
    const forcedSearchQuery = resolveForcedFirstSearch({
      alwaysSearch,
      turnMode,
      standaloneQuery,
      userSuppliedSource
    })
    const forcedSkip =
      alwaysSearch && turnMode === 'research' && userSuppliedSource
        ? userSuppliedSource
        : undefined
    try {
      onTurnPlan?.({
        turnMode,
        forcedSearch: forcedSearchQuery !== null,
        ...(forcedSkip && { forcedSkip })
      })
    } catch {
      // Telemetry must never break a turn.
    }

    if (turnMode === 'direct') {
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
    } else if (turnMode === 'stable-knowledge') {
      // A NEW question the classifier judged answerable without sources. See
      // resolveTurnMode for why this is ordered after skipSearch and why it
      // requires both flags.
      console.log(
        `[Researcher] Stable-knowledge mode: maxSteps=10, no search advertised, sources=${JSON.stringify(sources)}`
      )
      systemPrompt = STABLE_KNOWLEDGE_PROMPT
      // Same escape-hatch shape as skipSearch: `search` is deliberately NOT in
      // this list, so it is not advertised to the model, but it remains in the
      // tools map below so a model that reaches for it anyway is executed
      // rather than failing. That is the recovery path for a wrong `false`.
      activeToolsList = ['calculate', 'get_weather', 'remember', 'recall']
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
          systemPrompt = getQuickModePrompt()
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

    // Prompt-injection hardening: text returned by `search`/`fetch` is untrusted
    // third-party data that may be crafted to look like instructions. Standing
    // rule (every turn advertises or escape-hatches to those tools) that such
    // content is data, never commands. Pairs with the remember-gate below.
    systemPrompt = systemPrompt + UNTRUSTED_CONTENT_RULE

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

    // Tell the answering model its first search already ran. Appended after
    // the mode prompt so it supersedes that prompt's "clarifying your own
    // prior answer — do NOT search" exception (later instructions win).
    if (forcedSearchQuery !== null) {
      systemPrompt = systemPrompt + getForcedSearchPromptAddendum()
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

    // Attached-source citation permission (SPIKE finding #1). The mode prompts'
    // citation-integrity clause tells the model to cite ONLY `search`/`fetch`
    // calls it made this turn and to silently discard any other anchor — which
    // would throw away a citation to an attached document/URL even though the
    // client machinery resolves it. Appended AFTER the base prompt (later
    // instructions supersede earlier ones) so it carves out the exception,
    // names each real toolCallId, and keeps every other citation rule intact.
    if (documentRetrievalSources && documentRetrievalSources.length > 0) {
      const many = documentRetrievalSources.length > 1
      const list = documentRetrievalSources
        .map(
          s =>
            `- "${sanitizeSourceTitle(s.title)}" — toolCallId: ${s.toolCallId}`
        )
        .join('\n')
      // CITATION_HANDLES on: each excerpt's result carries its own `cite`
      // string (buildDocumentRetrievalModelMessages), so the model copies the
      // excerpt it used instead of writing [1] with a copied id. Off: the
      // previous clause, byte for byte.
      const docCiteRule = isCitationHandlesEnabled()
        ? "you MAY and SHOULD cite its excerpts inline. Each excerpt has a `cite` field holding its ready-made citation: copy the `cite` string of the excerpt you used, exactly. This permission OVERRIDES the citation-integrity rule that otherwise restricts citations to `search`/`fetch` calls — the `documentRetrieval` toolCallIds listed above ARE valid citation anchors. Every other citation rule still applies: never compose, renumber or edit a citation, and place the citation after the sentence's period."
        : `you MAY and SHOULD cite its excerpts inline as [1](#<toolCallId>). The citation number MUST be the digit 1 (never the literal letter "n"): these excerpts are pre-ranked, so 1 refers to the source's most relevant excerpt. Copy the EXACT toolCallId shown above (a 36-character UUID with four hyphens) in full after the "#". If you cite more than one attached source, use [1] with EACH source's OWN toolCallId (e.g. [1](#<first-id>) and [1](#<second-id>)) — the number is the excerpt rank within a single source, not a running counter, so every attached-source citation uses 1. This permission OVERRIDES the citation-integrity rule that otherwise restricts citations to \`search\`/\`fetch\` calls — the \`documentRetrieval\` toolCallIds listed above ARE valid citation anchors. Every other citation rule still applies: copy the id character-for-character, never invent or shorten an id, and place the citation after the sentence's period.`
      systemPrompt =
        systemPrompt +
        `\n\n## Attached sources — already retrieved for you (CITABLE)

The user attached ${many ? 'documents/URLs that have' : 'a document or URL that has'} ALREADY been retrieved for you this turn via the \`documentRetrieval\` tool. ${many ? 'These are REAL tool calls' : 'This is a REAL tool call'} from THIS turn — not invented anchors:
${list}

Treat each exactly like a \`search\` or \`fetch\` result from this turn: ${docCiteRule} When the user's question is about an attached document or URL, ground your answer in these excerpts and cite them.`
    }

    // Teach the agent when/how to reach for generateImage — but only when the
    // tool is actually registered (same gate as activeToolsList and the tools
    // object below). Appending guidance for an unregistered tool would prompt
    // the model to hallucinate calls to a tool that isn't available.
    if (isImageGenEnabled() && userId) {
      systemPrompt = systemPrompt + IMAGE_TOOL_GUIDANCE
    }

    // Wall clock for the answer deadline. Started here rather than passed in
    // from the route: this is the point after which everything remaining is
    // model round trips, which is what the deadline is protecting. Read both by
    // prepareStep (stops advertising tools) and by the execute wrapper below
    // (refuses a call the model emits anyway).
    const turnStartedAt = Date.now()
    const pastAnswerDeadline = () =>
      Date.now() - turnStartedAt >= ANSWER_DEADLINE_MS
    // The search cap (lib/agents/search-cap.ts). The step at which `search`
    // stopped being offered: the first step that started with this turn's
    // search budget spent (searchRounds against the mode's budget, or a
    // refused search). Recorded once by prepareStep; stages 2 and 3 count
    // from it. null until then.
    let searchWithdrawnAt: number | null = null
    const searchRoundsBudget = resolveSearchRoundsBudget(searchMode)
    // Why `search` is gone, worded like the mode's cap notice.
    const searchWithdrawnNote = resolveSearchWithdrawnNote(searchMode)
    // Set by prepareStep once the search cap switches the turn to answer-now:
    // stage 2, the model called `search` after it was withdrawn; stage 3, too
    // many tool steps without `search` in a mode whose cap notice says
    // "answer now". From then on the execute wrapper below refuses tool calls
    // exactly as it does past the deadline.
    let searchCapAnswerNow = false
    // Stage 3's limit for this turn's mode; null (quality) = no limit.
    const postCapToolStepsLimit = resolvePostCapToolStepsLimit(searchMode)

    // Build tools object with proper typing
    const rawTools: ResearcherTools = {
      search: searchTool,
      fetch: fetchTool,
      askQuestion: askQuestionTool,
      calculate: calculateTool,
      get_weather: weatherTool,
      remember: createRememberTool(
        // Injection hardening: on a retrieval-driven (research) turn, a
        // `remember` call may have been induced by instructions embedded in an
        // untrusted retrieved page, so write it candidate-only (requires
        // graduation before it is injected) rather than an immediately-active
        // confirmed memory. Direct / stable-knowledge turns answer without
        // retrieval, so a genuine user-directed "remember X" there stays an
        // immediate confirmed write.
        userId,
        turnMode !== 'direct' && turnMode !== 'stable-knowledge'
      ),
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

    // `activeTools: []` from applyAnswerDeadline only stops ADVERTISING tools;
    // the SDK still executes a call against this map. Wrapping every execute
    // is what actually stops a late search/fetch from running past the
    // deadline — or past the search cap's answer-now switch (same refusal).
    const tools = enforceAnswerDeadline(
      rawTools,
      () => pastAnswerDeadline() || searchCapAnswerNow,
      name =>
        console.log(
          pastAnswerDeadline()
            ? `[deadline] refused ${name} call at ${Math.round((Date.now() - turnStartedAt) / 1000)}s — answering from gathered sources`
            : `[search-cap] refused ${name} call on an answer-now step after the round cap — answering from gathered sources (chat=${currentChatId ?? '?'})`
        )
    )

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

    // The turn's answering model. Built here rather than inline so the
    // citation reminder's answer-step guard can wrap it (below).
    const answeringModel = getModel(model, abortSignal, turnMode)

    // Citation reminder on the answer step of a long loop
    // (lib/agents/citation-reminder.ts). The guard re-runs a step with the
    // reminder only once that step has started writing the answer; each attempt
    // gets its own model instance whose HTTP request `attemptSignal` can cut
    // off (ai-sdk-ollama ignores the per-call abortSignal). Built lazily, once
    // per turn; null when the turn's model is not a v3 model object.
    let answerStepModel: LanguageModelV3 | null | undefined
    const getAnswerStepModel = (): LanguageModelV3 | null => {
      if (answerStepModel !== undefined) return answerStepModel
      const isV3 = (m: unknown): m is LanguageModelV3 =>
        typeof m === 'object' &&
        m !== null &&
        (m as { specificationVersion?: string }).specificationVersion === 'v3'
      answerStepModel = isV3(answeringModel)
        ? createAnswerStepReminderModel({
            base: answeringModel,
            makeModel: attemptSignal => {
              const m = getModel(
                model,
                abortSignal
                  ? AbortSignal.any([abortSignal, attemptSignal])
                  : attemptSignal,
                turnMode
              )
              return isV3(m) ? m : (answeringModel as LanguageModelV3)
            },
            reminder: getCitationReminderText(),
            onRetry: ({ detectMs, abortedTextChars }) =>
              console.log(
                `[citation-reminder] ${JSON.stringify({ chatId: currentChatId ?? null, event: 'answer-step-rerun', detect_ms: detectMs, aborted_text_chars: abortedTextChars })}`
              )
          })
        : null
      return answerStepModel
    }
    // Logged once per turn, at the first step that gets the reminder.
    let citationReminderLogged = false

    // Built once per turn; handed to step 0 only (prepareStep below). Its
    // call runs the real, fully wrapped `search` tool from `tools`.
    const forcedSearchModel =
      forcedSearchQuery !== null
        ? createForcedSearchModel({
            input: buildForcedSearchInput(forcedSearchQuery, firstSearchDepth)
          })
        : null
    if (forcedSearchModel) {
      console.log(
        `[Researcher] always-search: step 0 forced to search "${forcedSearchQuery!.slice(0, 80)}" (turnMode=${turnMode}, mode=${searchMode})`
      )
    } else if (forcedSkip) {
      console.log(
        `[Researcher] always-search: the user supplied the source (${forcedSkip}) — first step not forced, search stays available`
      )
    } else if (alwaysSearch && turnMode === 'research') {
      console.log(
        `[Researcher] always-search: nothing searchable in the resolved query — first step not forced`
      )
    }

    // Create ToolLoopAgent with all configuration
    const agent = new ToolLoopAgent({
      // turnMode is forwarded so ANSWER_THINK=targeted can turn the answering
      // model's reasoning ON for research turns (needsSources/needsRecent) and
      // keep it OFF for direct/stable-knowledge quick lookups. Fixed
      // ANSWER_THINK values ignore turnMode, so this is a no-op for them.
      model: answeringModel,
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
      // Wired UNCONDITIONALLY now, not only when a variant wants per-step
      // control. Every turn needs the answer deadline: measured on 80
      // balanced-mode turns, two ran to route.ts's 300s ceiling at 17-18 steps
      // and persisted NOTHING — five minutes of waiting for a blank page — with
      // four more between 245s and 276s. See lib/agents/answer-deadline.ts.
      prepareStep: (({ stepNumber, steps, messages }: FlowStepArgs) => {
        const variant: FlowStepOverrides = flow.prepareStep
          ? flow.prepareStep({
              stepNumber,
              steps: steps as readonly FlowStep[],
              skipSearch
            })
          : {}
        // As soon as this turn's search budget is spent, stop offering
        // `search` (lib/agents/search-cap.ts): from the search tool's own
        // round counter, so no step has to call it just to be refused first;
        // a refused search also counts, as a fallback. The refusal notice
        // alone is ignored by some models — 80 refused calls on one prod turn.
        // Recorded once: the counter never goes down.
        const capSteps = steps as readonly SearchCapStep[]
        if (
          searchWithdrawnAt === null &&
          searchBudgetSpent(capSteps, {
            roundsUsed: searchRounds.used,
            roundsBudget: searchRoundsBudget
          })
        ) {
          searchWithdrawnAt = stepNumber
          console.log(
            `[search-cap] search withdrawn at step ${stepNumber} after the round cap (rounds ${searchRounds.used}/${searchRoundsBudget}, chat=${currentChatId ?? '?'})`
          )
        }
        // Narrows the variant's own list when it set one, else the mode's.
        const capped = withdrawSearchAfterCap(variant, {
          withdrawnAtStep: searchWithdrawnAt,
          defaultActiveTools: activeToolsList
        })
        // Stage 2: the model called `search` on a step that ran without it,
        // so the rest of the turn is answer-now (no tools + the deadline's
        // note). Sticky: it reads the same steps every later step.
        const evaded = answerNowOnSearchEvasion(capped, {
          steps: capSteps,
          withdrawnAtStep: searchWithdrawnAt,
          systemPrompt: effectiveSystemPrompt
        })
        // Stage 3 (modes without a fetch budget): enough tool steps without
        // `search`, so the rest of the turn is answer-now too.
        const postCap = answerNowAfterPostCapToolSteps(evaded, {
          steps: capSteps,
          withdrawnAtStep: searchWithdrawnAt,
          systemPrompt: effectiveSystemPrompt,
          maxToolSteps: postCapToolStepsLimit
        })
        // One answer-now switch per turn, logged under whichever stage fired
        // first; the other then has nothing left to withdraw.
        if (postCap !== capped && !searchCapAnswerNow) {
          searchCapAnswerNow = true
          console.log(
            evaded !== capped
              ? `[search-cap] model kept calling search after withdrawal at step ${stepNumber} — tools withdrawn, answering now (chat=${currentChatId ?? '?'})`
              : `[search-cap] ${toolStepsAfterWithdrawal(capSteps, searchWithdrawnAt)} tool steps after the round cap — tools withdrawn, answering now (chat=${currentChatId ?? '?'})`
          )
        }
        // Applied after the variant and every search-cap stage so it wins
        // over a variant's own activeTools (and over every stage): which
        // tools are visible mid-loop is a preference, having a step left to
        // answer in is not. `deadline !== postCap` below means the TIME
        // deadline fired, nothing else.
        const deadline = applyAnswerDeadline(postCap, {
          elapsedMs: Date.now() - turnStartedAt,
          systemPrompt: effectiveSystemPrompt
        })
        if (deadline !== postCap) {
          console.log(
            `[deadline] ${Math.round((Date.now() - turnStartedAt) / 1000)}s elapsed at step ${stepNumber} — tools withdrawn, answering now`
          )
        }
        // Stage 1's note, last: on a step that lost `search` and is not an
        // answer-now step, say why it is gone (the model may never have seen
        // a refusal), once. Answer-now steps carry ANSWER_NOW_NOTE instead.
        const o = withSearchWithdrawnNote(deadline, {
          offered: variant,
          withdrawn: capped,
          systemPrompt: effectiveSystemPrompt,
          note: searchWithdrawnNote
        })
        // A `system` override REPLACES the instructions for that step, so the
        // date has to be re-appended — whoever produced the override — or the
        // model silently loses it partway through a turn.
        const withDate = o.system
          ? {
              ...o,
              system: `${o.system}\nCurrent date and time: ${currentDate}`
            }
          : o
        // Long loop: restate the citation contract right before the answer
        // instead of only 100k tokens up, in the system prompt. On the
        // deadline step (tools withdrawn, so it IS the answer) it is appended
        // to the step's messages; on any other late step the answer-step
        // guard adds it only if the step turns out to be the answer. Per-step
        // only — the SDK rebuilds the next step's input from the turn's own
        // messages. See lib/agents/citation-reminder.ts.
        const citableToolCalls = countCitableToolCalls(
          steps as readonly FlowStep[]
        )
        let reminderMode =
          stepNumber > 0
            ? resolveCitationReminderMode({
                citableToolCalls,
                // Tools withdrawn and the answer-now note in force, so this
                // step writes the answer by construction: the time deadline,
                // or a search-cap answer-now stage (same override).
                answerDeadlinePassed: deadline !== postCap || postCap !== capped
              })
            : 'none'
        if (reminderMode === 'append' && !Array.isArray(messages)) {
          reminderMode = 'none'
        }
        const guardModel =
          reminderMode === 'answer-step' ? getAnswerStepModel() : null
        if (reminderMode === 'answer-step' && !guardModel) reminderMode = 'none'
        if (reminderMode !== 'none' && !citationReminderLogged) {
          citationReminderLogged = true
          console.log(
            `[citation-reminder] ${JSON.stringify({ chatId: currentChatId ?? null, event: 'armed', mode: reminderMode, step: stepNumber, citableToolCalls })}`
          )
        }
        const stepOverrides =
          reminderMode === 'append'
            ? { ...withDate, messages: withCitationReminder(messages!) }
            : guardModel
              ? { ...withDate, model: guardModel }
              : withDate
        // ALWAYS_SEARCH: step 0 runs on the synthetic model, whose only
        // output is the `search` call. The per-step `model` override is
        // honoured by the SDK itself (streamText resolves
        // prepareStepResult.model), unlike toolChoice, which the Ollama
        // provider drops. From step 1 the real model runs as before.
        return (
          stepNumber === 0 && forcedSearchModel
            ? { ...stepOverrides, model: forcedSearchModel }
            : stepOverrides
        ) as never
      }) as never,
      // No toolChoice forcing by default and no dedicated "done" tool —
      // matches upstream Morphic's proven pattern. The loop stops the moment
      // the model responds with plain text and no tool calls; forcing a tool
      // call on every step (as a prior version did) left weaker models with no
      // valid way to finish except an unfamiliar "stop" tool, so they looped
      // on search/fetch instead of ever answering. Variants that DO force a
      // step do it for one specific step, never for all of them — as does
      // ALWAYS_SEARCH, which forces step 0 only (via a per-step model
      // override in prepareStep above) and leaves every later step free.
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
