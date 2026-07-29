// PIPELINE ARCHITECTURE — retrieval is a system stage, not a model decision.
//
// This is not a variant of the agentic loop; it replaces the loop's control
// structure. The loop asks the model, at every step, "do I have enough or
// should I search again?" That question is why behaviour is not portable
// across models: on an identical probe set kimi-k2.6 answered it 19 times and
// minimax-m3 answered it 3 times. An architecture whose shape depends on which
// model is selected is not an architecture.
//
// So the model is never asked. The system retrieves, once, on a schedule it
// controls; the model gets one call at the end to write the answer with no
// tools available. Two properties follow, and both are the point:
//
//   * MODEL-AGNOSTIC. Step count is fixed by code. Swapping the model in the
//     UI changes prose quality and speed, never the flow.
//   * BOUNDED. One model round trip instead of 3-11. Measured on this stack a
//     round trip is ~10s and turn latency tracks prompt_tokens at r=0.76, so
//     removing round trips is the single largest lever available.
//
// SPECULATIVE START is the other half. Retrieval is fired on the user's RAW
// text before the classifier has returned — it does not wait to be understood.
// Measured preamble before the old first search: classify ~1.2s, recall ~5.0s
// (concurrent), first token ~7.7s. Starting at t=0 takes that off the critical
// path entirely; by the time understanding lands, sources are already in hand.
//
// The cost is searches we might not have needed. That trade is deliberate: a
// SearXNG query is cheap and parallel, a model round trip is ~10s and serial.
// Spending the cheap resource to save the expensive one is the whole idea.

import { generateId } from 'ai'

import {
  resolveOllamaSearchOptions,
  runAdvancedSearch
} from '@/lib/tools/search/advanced-search-client'
import { routeEmitsSearchTelemetry } from '@/lib/tools/search/basic-telemetry'
import type { SearchIntent } from '@/lib/tools/search/intent'
import {
  createSearchProvider,
  type SearchProviderType
} from '@/lib/tools/search/providers'
import type { SearchResults } from '@/lib/types'

/** How many results the single retrieval pass asks for. */
const PIPELINE_MAX_RESULTS = 20

/**
 * Is the pipeline architecture active? Separate from FLOW_VARIANT because the
 * variants are knobs INSIDE the loop, and this removes the loop. Keeping them
 * on different switches stops "pipeline" from being read as one more arm.
 */
export function pipelineArchEnabled(): boolean {
  return process.env.FLOW_ARCH === 'pipeline'
}

export type PipelineRetrieval = {
  query: string
  results: SearchResults | null
  ms: number
  error?: string
  /**
   * Identity of this retrieval, minted before it runs.
   *
   * It is not decoration: the whole downstream citation/sources stack is keyed
   * on a search tool call's id, and under this architecture there is no tool
   * call to take one from. The SAME id goes into the model's prompt (as the
   * anchor it must cite against) and into the synthesized `tool-search` UI part
   * (buildRetrievalToolPart), which is what makes `[1](#id)` resolve to a real
   * URL in lib/utils/citation.ts.
   */
  toolCallId: string
}

/**
 * Does this turn's speculative retrieval reach the model's prompt?
 *
 * Retrieval always FIRES (that is the speculative half of the architecture);
 * this decides whether the sources are kept or discarded. `skipSearch` covers
 * turns answerable from the conversation itself, `needsRecent` turns whose
 * answer depends on current facts.
 *
 * Exported as a predicate — rather than left inline at the one place that
 * gates — because the telemetry has to report the SAME decision the researcher
 * made. It previously reported the retrieval's own result count regardless of
 * this gate, which made a discarded turn indistinguishable from an injected
 * one and produced a "the gate never fired" reading of a run where it fired on
 * 9 of 16 probes.
 */
export function shouldInjectRetrieval({
  skipSearch,
  needsRecent
}: {
  skipSearch: boolean
  needsRecent: boolean
}): boolean {
  return !skipSearch && needsRecent
}

/**
 * Fire retrieval immediately, on the raw user text.
 *
 * Deliberately NOT awaited by the caller — the returned promise is handed to
 * the researcher, which awaits it only when it is ready to build the prompt.
 * That is what puts retrieval and understanding on the same clock instead of
 * one behind the other.
 *
 * Never rejects. A failed retrieval must degrade to an unsourced answer, not
 * take the turn down: the old loop could at least try another tool, and this
 * architecture has no second chance by construction.
 */
export function startSpeculativeRetrieval(
  rawQuery: string,
  opts: {
    timeRange?: 'day' | 'week' | 'month' | 'year'
    intent?: SearchIntent
    chatId?: string
  } = {}
): Promise<PipelineRetrieval> {
  const query = rawQuery.trim()
  const startedAt = Date.now()
  // Minted here, not when the results land, so the id exists even for the
  // empty-query and failure paths — every caller can rely on it being present.
  const toolCallId = generateId()

  if (!query) {
    return Promise.resolve({ query, results: null, ms: 0, toolCallId })
  }

  // ONE system-level retry when the first pass returns nothing.
  //
  // Measured: 7 of 16 probes retrieved zero sources, with retrieval_ms sitting
  // at ~4000ms — exactly searxng's `outgoing.request_timeout: 4.0`. One of them
  // asked for the current PostgreSQL version, which cannot be answered from
  // parametric knowledge, and it was answered ungrounded.
  //
  // The loop recovered from this by searching again. Removing the loop removed
  // that recovery, so it comes back as CODE. Deliberately NOT handed to the
  // model: "did that work, should I try again?" is the exact judgment whose
  // per-model variance this architecture exists to eliminate. A fixed retry
  // behaves identically on every model; a model deciding does not.
  //
  // One retry, not a loop. If the second pass is also empty the honest outcome
  // is an unsourced answer that says so, which buildSourceBlock handles.
  //
  // Routed through /api/advanced-search — the SAME path the search tool's
  // first search of a turn takes (lib/tools/search.ts), via the shared client.
  // This used to call `createSearchProvider(searchAPI).search(q, 20,
  // 'advanced', …)` directly, which looks equivalent and is not: the provider
  // ignores the depth argument, so there was no crawl, no snippet gate and no
  // cross-encoder rerank, and the "sources" were 100-300 char engine snippets.
  // The per-source 1200-char cap in buildSourceBlock never once had anything
  // to truncate. Depth was the entire reason the loop's first search was worth
  // replacing; retrieving shallower than it would have made the comparison
  // meaningless.
  //
  // `stream: false` because this fires before the UI message stream exists —
  // there is nowhere to put a preview. The synthesized tool part
  // (buildRetrievalToolPart) is written once, from the final payload.
  const searchAPI = (process.env.SEARCH_API || 'searxng') as SearchProviderType
  // The SAME predicate that decides where the search TOOL sends a search, so
  // the two cannot drift. Only searxng+advanced belongs to the route; a
  // deployment configured for Tavily/Exa keeps the direct provider call it
  // always had, because sending it to /api/advanced-search would silently
  // substitute SearXNG for its configured provider — or 500, if SearXNG is not
  // configured on that host at all.
  const useAdvancedRoute = routeEmitsSearchTelemetry(searchAPI, 'advanced')

  const attempt = (): Promise<SearchResults> =>
    useAdvancedRoute
      ? runAdvancedSearch({
          query,
          maxResults: PIPELINE_MAX_RESULTS,
          searchDepth: 'advanced',
          timeRange: opts.timeRange,
          intent: opts.intent,
          chatId: opts.chatId,
          ...resolveOllamaSearchOptions(),
          stream: false
        }).then(r => r.results)
      : createSearchProvider(searchAPI).search(
          query,
          PIPELINE_MAX_RESULTS,
          'advanced',
          [],
          [],
          { time_range: opts.timeRange, intent: opts.intent }
        )

  return attempt()
    .then(async first => {
      if ((first?.results?.length ?? 0) > 0) return first
      console.log('[pipeline] first retrieval empty — retrying once')
      try {
        return await attempt()
      } catch {
        return first
      }
    })
    .then(results => {
      const ms = Date.now() - startedAt
      console.log(
        `[pipeline] speculative retrieval: ${results?.results?.length ?? 0} results in ${ms}ms`
      )
      return { query, results, ms, toolCallId }
    })
    .catch((e: unknown) => {
      const ms = Date.now() - startedAt
      const error = e instanceof Error ? e.message : String(e)
      console.log(
        `[pipeline] speculative retrieval FAILED in ${ms}ms: ${error}`
      )
      return { query, results: null, ms, error, toolCallId }
    })
}

/**
 * The header that cancels the loop's instructions.
 *
 * The search-mode prompts (lib/agents/prompts/search-mode-prompts.ts) are
 * written for the agentic loop and say, repeatedly, that the FIRST action of
 * every turn MUST be the `search` tool and that answering from memory instead
 * of verifying with a fresh search is forbidden. Under this architecture
 * `search` and `fetch` are removed from activeTools before the provider ever
 * sees the request, so those lines order the model to do something it
 * physically cannot — and a model told to do the impossible hedges, apologises
 * and narrates about tools instead of answering.
 *
 * Cancelled HERE, in what the pipeline path appends, rather than by editing
 * the shared prompts: the loop is still the default architecture and its
 * prompt must keep working unchanged. This block is appended last, and "later
 * instructions supersede earlier ones" is already the convention those prompts
 * rely on (quality mode overrides balanced the same way).
 */
function pipelineTurnHeader(): string[] {
  return [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'RESEARCH IS ALREADY DONE — THIS SECTION OVERRIDES EVERYTHING ABOVE',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    // Precise about WHICH tools are gone: the researcher strips `search` and
    // `fetch` from activeTools, and nothing else. Claiming "no tools at all"
    // would be false wherever calculate/generateImage are still registered,
    // and a prompt the model can catch being wrong is a prompt it starts
    // second-guessing.
    'The research for this turn was carried out before you were called. `search` and `fetch` have been REMOVED from your tools for this turn — you cannot call them, and any attempt will not run.',
    '',
    '- Every instruction above about calling `search` first, searching before answering, verifying claims with a fresh search, fetching a page for depth, or never answering without searching does NOT apply to this turn. Ignore it.',
    '- Do NOT mention tools, searching, browsing, or their absence in your answer. Do NOT apologise for not searching. Write as though the research were simply done — it is.',
    '- Write the final answer now, from the sources below. There is no second research pass.'
  ]
}

/**
 * Render retrieved sources into the system prompt.
 *
 * Numbered because the citation contract downstream is positional — the model
 * cites what it is shown, and inventing an anchor for a source it was not given
 * is the failure mode worth designing against. Content is truncated per source
 * rather than globally so one long page cannot crowd out the rest; turn latency
 * tracks prompt_tokens closely enough that an unbounded context is a latency
 * bug, not just a cost one.
 *
 * The citation format is `[N](#toolCallId)` — the SAME format the base prompts
 * mandate, and the only one lib/utils/citation.ts can resolve. It previously
 * said "cite as [1], [2]", which contradicted the base prompt two paragraphs
 * earlier AND produced markers that processCitations leaves untouched: a bare
 * [1] never becomes a link. One retrieval means one anchor, so every source
 * number on this turn shares the same id.
 */
export function buildSourceBlock(retrieval: PipelineRetrieval): string {
  const rows = retrieval.results?.results ?? []
  if (rows.length === 0) {
    return [
      ...pipelineTurnHeader(),
      '',
      '## Retrieved sources',
      '',
      'No sources were retrieved for this question.',
      'Answer from your own knowledge, and say plainly that you could not consult sources.',
      'Do NOT invent citations — write no citation markers at all this turn.'
    ].join('\n')
  }

  const PER_SOURCE_CHARS = 1200
  const lines = rows.slice(0, PIPELINE_MAX_RESULTS).map((r, i) => {
    const content = (r.content || '')
      .replace(/\s+/g, ' ')
      .slice(0, PER_SOURCE_CHARS)
    return `[${i + 1}] ${r.title || '(untitled)'}\nURL: ${r.url}\n${content}`
  })

  const id = retrieval.toolCallId

  return [
    ...pipelineTurnHeader(),
    '',
    '## Retrieved sources',
    '',
    `These ${lines.length} sources were retrieved for this question BEFORE you were called. They are all you have.`,
    'If they do not answer part of the question, say so in one clause rather than guessing.',
    '',
    'CITATION FORMAT for this turn — this REPLACES every citation instruction above:',
    `- Cite inline as [N](#${id}) where N is a source number below and the anchor is exactly \`${id}\` every time.`,
    // The example cites [1], which is always a source that exists — this
    // branch only runs with at least one row. An example citing a number the
    // list does not contain is the exact mistake the next line forbids.
    `- Example: "PostgreSQL 18.4 fixed the planner regression. [1](#${id})"`,
    '- All sources this turn share that one anchor. Never write a bare [N] with no anchor, never invent a different anchor, and never cite a number that is not listed below.',
    '- Placement is unchanged: finish the sentence, add the period, then the citation.',
    '- You were given no image URLs this turn, so do not emit an inline image spec block and never invent image URLs.',
    '',
    lines.join('\n\n')
  ].join('\n')
}

/** The tool part's shape as the UI and the persistence layer expect it. */
export type SynthesizedSearchToolPart = {
  toolCallId: string
  toolName: 'search'
  input: {
    query: string
    search_mode: 'web'
    type: 'optimized'
    content_types: ['web']
    max_results: number
    search_depth: 'advanced'
    include_domains: string[]
    exclude_domains: string[]
  }
  output: SearchResults & { state: 'complete' }
}

/**
 * Forge the `tool-search` message part the rest of the app is built around.
 *
 * WHY THIS EXISTS — the entire provenance stack keys on a search TOOL CALL,
 * and this architecture has none:
 *   - lib/utils/citation.ts:42-49 builds citation maps ONLY from parts whose
 *     type is `tool-search` with state `output-available`, keyed by
 *     `toolCallId`, deriving citation N from `output.results[N-1]`. With no
 *     such part extractCitationMaps returns {} and processCitations
 *     early-returns the text unchanged (citation.ts:102-104) — so `[1](#id)`
 *     is rendered as literal text, or stripped, never as a link.
 *   - components/render-message.tsx:254-266 buffers only `tool-*`,
 *     `reasoning` and `data-*` parts into ResearchProcessSection. With no tool
 *     part there is no sources panel, no images and no videos — a pipeline
 *     answer had ZERO visible provenance.
 *   - components/search-section.tsx:54-57 reads results only when
 *     `output.state === 'complete'`, hence the marker on the output below.
 *
 * The alternative — teaching the citation stack about a second, retrieval-
 * shaped source of truth — means touching citation extraction, the research
 * panel, the inspector, the DB part mapping and the artifact view. Producing
 * the shape they already consume is one function and no new contract.
 *
 * The `input` is what the model WOULD have had to pass to get this retrieval,
 * so the panel header renders the query and the inspector shows a coherent
 * call. Nothing reads it back as an instruction.
 *
 * The slice must match buildSourceBlock's: citations resolve POSITIONALLY
 * (citation N -> results[N-1]), so if the prompt showed a different set, or a
 * different order, than this part carries, every citation would point at the
 * wrong page while still looking perfectly valid.
 */
export function buildRetrievalToolPart(
  retrieval: PipelineRetrieval
): SynthesizedSearchToolPart {
  const results = (retrieval.results?.results ?? []).slice(
    0,
    PIPELINE_MAX_RESULTS
  )

  return {
    toolCallId: retrieval.toolCallId,
    toolName: 'search',
    input: {
      query: retrieval.query,
      search_mode: 'web',
      type: 'optimized',
      content_types: ['web'],
      max_results: PIPELINE_MAX_RESULTS,
      search_depth: 'advanced',
      include_domains: [],
      exclude_domains: []
    },
    output: {
      // 'complete' is the streaming marker the real search tool ends on; the
      // UI treats anything else as still-searching and renders a skeleton
      // forever.
      state: 'complete',
      results,
      images: retrieval.results?.images ?? [],
      query: retrieval.query,
      number_of_results: results.length,
      // Same id inside the payload as on the part, matching what the search
      // tool attaches (lib/tools/search.ts) — persisted-message consumers read
      // it from either place.
      toolCallId: retrieval.toolCallId
    }
  }
}
