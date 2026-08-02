import { type JSONValue, tool, UIToolInvocation } from 'ai'

import {
  cosineSimilarity,
  embedTexts,
  getConfiguredModel
} from '@/lib/embeddings/transformers-embedding'
import { getSearchSchemaForModel } from '@/lib/schema/search'
import {
  basicSearchCacheKey,
  redisCacheIO,
  withBasicSearchCache
} from '@/lib/search/basic-search-cache'
import type { FullContentByToolCall } from '@/lib/search/rehydrate-full-content'
import { buildSearchTelemetryTag } from '@/lib/telemetry/search-tag'
import { StageTimer } from '@/lib/telemetry/stage-timer'
import { SearchResultItem, SearchResults } from '@/lib/types'
import { readNdjson } from '@/lib/utils/ndjson'
import { isOllamaSearchConfigured } from '@/lib/utils/ollama-search-client'
import {
  getGeneralSearchProviderType,
  getSearchToolDescription
} from '@/lib/utils/search-config'
import { getBaseUrlString } from '@/lib/utils/url'
import { logToolPayload } from '@/lib/utils/usage-logging'

import {
  countSearchPayload,
  routeEmitsSearchTelemetry
} from './search/basic-telemetry'
import {
  createSearchProvider,
  DEFAULT_PROVIDER,
  SearchProviderType
} from './search/providers'
import type {
  SearchContentType,
  SearchModeOption
} from './search/providers/base'
import { mergeGeneralSearchResults } from './search/providers/merge-general'

export type SearchToolOptions = {
  // Per-turn recency preference from the query classifier (needsRecent).
  // Applied to every search this turn makes, in both basic and advanced
  // SearXNG paths.
  timeRange?: 'day' | 'week' | 'month' | 'year'
  // Diverse reformulations of the turn's resolved query, produced by
  // lib/agents/query-expander.ts (kicked off in parallel with message
  // prep). The FIRST search of the turn also searches these variants
  // concurrently (basic depth) and merges unique-URL results, widening
  // discovery beyond a single phrasing. A rejected/empty promise means
  // single-query search, exactly the pre-expansion behavior.
  expandedQueries?: Promise<string[]>
  // Collects FULL crawled text per toolCallId so the persisted message can
  // carry it while the live prompt only gets excerpts. See
  // lib/search/rehydrate-full-content.ts for why.
  fullContentSink?: FullContentByToolCall
  // Current chat id, forwarded to /api/advanced-search purely so its
  // [latency:search] line can be joined to the [latency] turn line. Turns
  // make multiple searches, so ordering does not identify them.
  chatId?: string
  // Auto-detected intent for this turn (query classifier). Passed to both
  // search paths; additively routes to intent-specific engines.
  intent?: import('./search/intent').SearchIntent
  // Depth for the FIRST search of the turn (set by researcher per mode):
  // 'advanced' for balanced/quality, 'basic' for speed/skip. Depth tiering
  // forces only the first search to this depth, then tiers subsequent
  // searches down to 'basic' — the model deep-reads specific URLs via the
  // fetch tool instead of re-running advanced crawls.
  firstSearchDepth?: 'basic' | 'advanced'
}

// Ollama's web-search API clamps max_results to 10 server-side (verified by
// requesting 20/50/100 and getting exactly 10 each time). Asking for more is
// silently ignored, so the value is clamped here instead — an operator who
// sets OLLAMA_SEARCH_MAX_RESULTS=50 should see 10, not believe they get 50.
const OLLAMA_SEARCH_HARD_MAX = 10

// Returns the index of the first prior query embedding whose cosine
// similarity to `embedding` meets/exceeds `threshold`, or -1 if none. Used to
// skip near-duplicate query reformulations within a single research turn.
export function findDuplicateQueryIndex(
  embedding: number[],
  priorEmbeddings: number[][],
  threshold: number
): number {
  for (let i = 0; i < priorEmbeddings.length; i++) {
    if (cosineSimilarity(embedding, priorEmbeddings[i]) >= threshold) return i
  }
  return -1
}

// Depth-tiering decision. When enabled (SEARCH_DEPTH_TIERING !== 'off'), the
// FIRST searxng search of a turn uses firstSearchDepth (advanced in deep
// modes) and every later search is forced to basic — capping the expensive
// crawl+rerank to once per turn. When disabled, or for non-searxng
// providers, it reproduces today's behavior exactly (env default beats the
// model-requested depth for searxng; otherwise the model's choice stands).
export function resolveEffectiveDepth(opts: {
  searchAPI: SearchProviderType
  modelRequestedDepth: 'basic' | 'advanced'
  envDefaultAdvanced: boolean
  firstSearchDepth: 'basic' | 'advanced'
  firstSearchDone: boolean
  tieringEnabled: boolean
}): 'basic' | 'advanced' {
  const {
    searchAPI,
    modelRequestedDepth,
    envDefaultAdvanced,
    firstSearchDepth,
    firstSearchDone,
    tieringEnabled
  } = opts

  if (tieringEnabled && searchAPI === 'searxng') {
    return firstSearchDone ? 'basic' : firstSearchDepth
  }

  // Baseline (unchanged): env default forces advanced for searxng; otherwise
  // honor the model-requested depth.
  return searchAPI === 'searxng' && envDefaultAdvanced
    ? 'advanced'
    : modelRequestedDepth
}

// Widen the first search of a turn with expansion-variant results:
// variants run at basic depth (snippets — discovery, not deep-crawl) and
// only URLs not already present are appended. Never throws.
async function searchExpansionVariants(
  variants: string[],
  timeRange: SearchToolOptions['timeRange'],
  chatId?: string
): Promise<SearchResults['results']> {
  const searchAPI =
    (process.env.SEARCH_API as SearchProviderType) || DEFAULT_PROVIDER
  // Measured HERE rather than on the tool's own timer, because expansion
  // only ever runs on the FIRST search of a turn — which in balanced and
  // quality modes is the advanced search, whose telemetry belongs to the
  // route and leaves the tool with no timer to record onto. Bolting these
  // numbers there made them unrecordable in exactly the modes that use them.
  //
  // These ARE basic searches (N concurrent, one per variant), so they carry
  // the same tag and a provider field like every other tool-emitted line.
  const timer = new StageTimer('latency:search', {
    ...buildSearchTelemetryTag({ chatId }),
    depth: 'basic',
    provider: searchAPI,
    // Distinguishes these from the model's own follow-up searches, which are
    // also basic and would otherwise be indistinguishable in aggregate.
    kind: 'expansion'
  })
  timer.set('variants', variants.length)

  let cacheMisses = 0
  const settled = await timer.time('search_ms', () =>
    Promise.allSettled(
      variants.map(v =>
        // Cached: the classifier runs at temperature 0, so the same question
        // yields the same variants every time and these repeat constantly.
        withBasicSearchCache(
          basicSearchCacheKey(v, 10, timeRange),
          () => {
            cacheMisses++
            return createSearchProvider(searchAPI).search(
              v,
              10,
              'basic',
              [],
              [],
              {
                time_range: timeRange
              }
            )
          },
          redisCacheIO
        )
      )
    )
  )

  const results = settled.flatMap(s =>
    s.status === 'fulfilled' ? (s.value.results ?? []) : []
  )
  // Variants run CONCURRENTLY, so search_ms is the slowest one, not the sum.
  // `failed` matters on its own: a variant that throws is swallowed here by
  // design, which silently narrows discovery with nothing else to show for it.
  timer.set('cache_misses', cacheMisses)
  timer.set('failed', settled.filter(s => s.status === 'rejected').length)
  timer.set('returned', results.length)
  timer.emit()
  return results
}

/**
 * Creates a search tool with the appropriate schema for the given model.
 */
export function createSearchTool(
  fullModel: string,
  toolOptions?: SearchToolOptions
) {
  // Expansion applies only to the first search of the turn: the model's
  // own follow-up searches are already reformulations by construction.
  let expansionUsed = false
  // Depth tiering applies only to the first search of the turn: later
  // searches tier down to basic (see resolveEffectiveDepth).
  let firstSearchDone = false
  // Per-turn search-intent dedup state, keyed within a search_mode so a web
  // search and an academic search of the same words aren't treated as dupes.
  const executedQueries: {
    mode: string
    query: string
    embedding: number[]
  }[] = []

  return tool({
    description: getSearchToolDescription(),
    inputSchema: getSearchSchemaForModel(fullModel),
    async *execute(
      {
        query,
        search_mode = 'web',
        type = 'optimized',
        content_types = ['web'],
        max_results = 20,
        search_depth = 'basic', // Default for standard schema
        include_domains = [],
        exclude_domains = []
      },
      context
    ) {
      // Records full crawled text for THIS tool call so onFinish can persist
      // it in place of the excerpt the model reads. No-op unless excerpting
      // actually shrank the payload (the route omits fullResults otherwise).
      const recordFull = (full?: SearchResultItem[]) => {
        try {
          const id = context?.toolCallId
          if (id && full && full.length > 0) {
            toolOptions?.fullContentSink?.set(id, full)
          }
        } catch {
          // Never break a search over telemetry-shaped bookkeeping.
        }
      }

      // Yield initial searching state
      yield {
        state: 'searching' as const,
        query
      }

      // Search-intent dedup: skip a near-duplicate reformulation of a query
      // already run this turn. Its results are already in the model's
      // context, so return a short note instead of paying for another
      // search+crawl+rerank. First search never dedups (nothing prior).
      //
      // Recording into executedQueries is deferred until AFTER the search
      // below actually succeeds (see the `currentQueryEmbedding` push near
      // the end of this function) — computing the embedding here only
      // decides duplicate-or-not. If we recorded eagerly and the search
      // then threw, a later identical retry would be wrongly skipped with a
      // "results are already above" note for results that were never
      // produced.
      const dedupEnabled = process.env.SEARCH_DEDUP_ENABLED !== 'off'
      let currentQueryEmbedding: number[] | null = null
      if (dedupEnabled && executedQueries.length > 0) {
        try {
          const threshold = Number(process.env.SEARCH_DEDUP_THRESHOLD ?? '0.92')
          const [queryEmbedding] = await embedTexts(
            [query],
            getConfiguredModel()
          )
          const priorSameMode = executedQueries.filter(
            e => e.mode === search_mode
          )
          const dupIdx = findDuplicateQueryIndex(
            queryEmbedding,
            priorSameMode.map(e => e.embedding),
            Number.isFinite(threshold) ? threshold : 0.92
          )
          if (dupIdx !== -1) {
            const priorQuery = priorSameMode[dupIdx].query
            console.log(
              `[search-dedup] skipping "${query}" — near-duplicate of "${priorQuery}"`
            )
            yield {
              state: 'complete' as const,
              results: [],
              images: [],
              query,
              number_of_results: 0,
              note: `Skipped: this search is a near-duplicate of an earlier search this turn ("${priorQuery}"). Those results are already above — reuse them, or search a materially different angle instead of rephrasing.`
            }
            return
          }
          // Not a duplicate — stash the embedding; recorded once the search
          // below actually succeeds.
          currentQueryEmbedding = queryEmbedding
        } catch (error) {
          // Embedding failure ⇒ treat as not-duplicate (search proceeds),
          // never worse than today. Nothing is recorded for this query, so a
          // later identical one simply gets its own embed attempt.
          console.error('[search-dedup] embedding failed, not deduping:', error)
        }
      } else if (dedupEnabled) {
        // First search of the turn: always compute one local embedding (no
        // prior entries to compare against yet) so later searches this turn
        // have something to compare against. Stashed here, not recorded
        // yet — recorded once the search below actually succeeds.
        try {
          const [queryEmbedding] = await embedTexts(
            [query],
            getConfiguredModel()
          )
          currentQueryEmbedding = queryEmbedding
        } catch (error) {
          console.error('[search-dedup] initial embed failed:', error)
        }
      }

      // Ensure max_results is at least 10
      const minResults = 10
      const effectiveMaxResults = Math.max(
        max_results || minResults,
        minResults
      )
      const effectiveSearchDepth = search_depth as 'basic' | 'advanced'

      // Use the original query as is - any provider-specific handling will be done in the provider
      const filledQuery = query
      let searchResult: SearchResults

      // Kick the expansion-variant searches off in parallel with the main
      // search below. Bounded: if the expander hasn't resolved shortly
      // after the main search completes, proceed without variants.
      //
      // The cap accommodates the expander running on granite4.1:8b
      // (~10-14s warm). It's a ceiling, not a fixed wait: the expander was
      // kicked off back at classification time, so by the time this first
      // search returns it has usually had a big head start and the race
      // resolves well before the ceiling. Worst case (expander still not
      // done) the turn proceeds single-query — never blocked, never an
      // error.
      const EXPANSION_MERGE_WAIT_MS = 12_000
      let variantResultsPromise: Promise<SearchResults['results']> | null = null
      if (!expansionUsed && toolOptions?.expandedQueries) {
        expansionUsed = true
        variantResultsPromise = Promise.race([
          toolOptions.expandedQueries,
          new Promise<string[]>(resolve =>
            setTimeout(() => resolve([]), EXPANSION_MERGE_WAIT_MS)
          )
        ])
          .then(variants =>
            variants.length > 0
              ? searchExpansionVariants(
                  variants,
                  toolOptions.timeRange,
                  toolOptions.chatId
                )
              : []
          )
          .catch(() => [])
      }

      // Determine which provider to use based on type
      let searchAPI: SearchProviderType
      if (type === 'general') {
        // Try to use dedicated general search provider
        const generalProvider = getGeneralSearchProviderType()
        if (generalProvider) {
          searchAPI = generalProvider
        } else {
          // Fallback to primary provider (optimized search provider)
          searchAPI =
            (process.env.SEARCH_API as SearchProviderType) || DEFAULT_PROVIDER
          console.log(
            `[Search] type="general" requested but no dedicated provider available, using optimized search provider: ${searchAPI}`
          )
        }
      } else {
        // For 'optimized', use the configured provider
        searchAPI =
          (process.env.SEARCH_API as SearchProviderType) || DEFAULT_PROVIDER
      }

      const tieringEnabled = process.env.SEARCH_DEPTH_TIERING !== 'off'
      const effectiveSearchDepthForAPI = resolveEffectiveDepth({
        searchAPI,
        modelRequestedDepth: (effectiveSearchDepth || 'basic') as
          | 'basic'
          | 'advanced',
        envDefaultAdvanced: process.env.SEARXNG_DEFAULT_DEPTH === 'advanced',
        firstSearchDepth: toolOptions?.firstSearchDepth ?? 'basic',
        firstSearchDone,
        tieringEnabled
      })
      // Does this search actually run the advanced pipeline (crawl + snippet
      // gate + cross-encoder rerank behind /api/advanced-search)? Same
      // predicate that routes it, so the two cannot drift.
      const usesAdvancedPipeline = routeEmitsSearchTelemetry(
        searchAPI,
        effectiveSearchDepthForAPI
      )

      // Consume the turn's ONE advanced slot only if this search actually used
      // it. Previously this was set unconditionally, which meant a first
      // search with type:'general' — routed to the Brave provider, never to
      // /api/advanced-search — still burned the slot. Every later search then
      // tiered to basic, so the turn silently got NO crawl, NO snippet gate
      // and NO rerank at all. The balanced prompt actively recommends
      // type="general" for current events, so this was reachable in normal use.
      //
      // Still at most one advanced search per turn: a general search leaves
      // the slot unclaimed, the next optimized search claims it, and
      // everything after that tiers down as before. Speed mode is unaffected
      // (firstSearchDepth is 'basic' there, so the slot is never claimed and
      // resolveEffectiveDepth returns 'basic' either way).
      if (usesAdvancedPipeline) firstSearchDone = true

      // Ollama web search runs on EVERY executing search of the turn when
      // enabled (no per-turn cap). A dedup-skipped search returns earlier and
      // never reaches here, so Ollama is only called for real searches.
      const useOllama =
        isOllamaSearchConfigured() &&
        process.env.OLLAMA_SEARCH_ENABLED !== 'off'
      // Default 10, which is the API's hard ceiling — verified empirically
      // 2026-07-28 by requesting 20, 50 and 100, all of which returned exactly
      // 10. The previous default of 5 left half the results unused for an
      // identical cost: Ollama meters per REQUEST, not per result, so asking
      // for 5 and asking for 10 are the same call at the same price.
      //
      // Unlike every other source, raising this REDUCES work. Ollama returns
      // full page content (~10k chars per result; 5 results measured 43.6k
      // chars, 10 measured 102.8k), and its URLs are the only ones added to
      // prefetchedUrls — so the crawler skips them. Five more results here are
      // five fewer pages Crawl4AI has to fetch, and crawl is 55-70% of turn
      // latency. It also costs no candidate-pool pressure for the same reason.
      const ollamaMaxEnv = Number(process.env.OLLAMA_SEARCH_MAX_RESULTS)
      const ollamaMaxResults =
        Number.isFinite(ollamaMaxEnv) && ollamaMaxEnv > 0
          ? Math.min(ollamaMaxEnv, OLLAMA_SEARCH_HARD_MAX)
          : OLLAMA_SEARCH_HARD_MAX

      console.log(
        `Using search API: ${searchAPI}, Type: ${type}, Search Depth: ${effectiveSearchDepthForAPI}`
      )

      // /api/advanced-search owns this search, so it emits the
      // [latency:search] line itself and the tool must not emit a second one.
      // Same value that decided the depth slot above — one expression drives
      // routing, slot consumption and telemetry, so none can drift apart.
      const routeReportsTelemetry = usesAdvancedPipeline

      // Per-search timing for the paths the route never sees. Started here so
      // it brackets exactly what the "Using search API" -> "completed search"
      // log pair brackets, keeping the line and the logs mutually checkable.
      const toolTimer = routeReportsTelemetry
        ? null
        : new StageTimer('latency:search', {
            ...buildSearchTelemetryTag({ chatId: toolOptions?.chatId }),
            depth: effectiveSearchDepthForAPI,
            intent: toolOptions?.intent ?? 'general',
            // Present only on tool-emitted lines — this is what tells the two
            // emitters apart when reading the log.
            provider: searchAPI
          })

      // The searxng branch cannot use this: its timing has to sit INSIDE
      // withBasicSearchCache so a cache hit is not billed as search time.
      const timeSearch = <T>(fn: () => Promise<T>): Promise<T> =>
        toolTimer ? toolTimer.time('search_ms', fn) : fn()

      try {
        if (routeReportsTelemetry) {
          // Get the base URL using the centralized utility function
          const baseUrl = await getBaseUrlString()
          // Default ON: the preview is strictly additive (an extra UI-only
          // yield), and the final line is identical to today's response.
          const streamPreview =
            process.env.SEARCH_STREAM_PREVIEW !== 'false' &&
            typeof ReadableStream !== 'undefined'

          const response = await fetch(`${baseUrl}/api/advanced-search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: filledQuery,
              maxResults: effectiveMaxResults,
              searchDepth: effectiveSearchDepthForAPI,
              includeDomains: include_domains,
              excludeDomains: exclude_domains,
              timeRange: toolOptions?.timeRange,
              intent: toolOptions?.intent,
              chatId: toolOptions?.chatId,
              useOllama,
              ollamaMaxResults,
              // NDJSON: a preview line as soon as the fan-out resolves (~2s),
              // then the crawled+reranked line (~15-20s). Sources render on
              // the preview instead of the user watching nothing until the
              // end. Off => today's single JSON response.
              stream: streamPreview
            })
          })
          if (!response.ok) {
            throw new Error(
              `Advanced search API error: ${response.status} ${response.statusText}`
            )
          }

          if (streamPreview && response.body) {
            let finalResult: SearchResults | undefined
            let finalFull: SearchResultItem[] | undefined
            for await (const line of readNdjson(response.body)) {
              const msg = line as { type?: string } & Partial<SearchResults>
              if (msg?.type === 'preview') {
                // Intermediate yields are UI-only — the model receives the
                // FINAL yield — so showing preliminary sources here cannot
                // put un-crawled content in front of the model.
                yield {
                  state: 'complete' as const,
                  results: msg.results ?? [],
                  images: [],
                  query: filledQuery,
                  number_of_results: msg.number_of_results ?? 0
                }
              } else if (msg?.type === 'final') {
                finalFull = (msg as { fullResults?: SearchResultItem[] })
                  .fullResults
                finalResult = {
                  results: msg.results ?? [],
                  query: msg.query ?? filledQuery,
                  images: msg.images ?? [],
                  number_of_results: msg.number_of_results ?? 0
                }
              }
            }
            if (!finalResult) {
              throw new Error('Advanced search stream ended with no final line')
            }
            searchResult = finalResult
            recordFull(finalFull)
          } else {
            const body = await response.json()
            searchResult = body
            recordFull(body?.fullResults)
          }
        } else {
          // Use the provider factory to get the appropriate search provider
          const searchProvider = createSearchProvider(searchAPI)

          if (searchAPI === 'brave') {
            // Brave (block-immune general API) and SearXNG (which merges
            // degoog + Ollama internally) run in PARALLEL and merge, so
            // general searches keep the full self-hosted source union
            // alongside Brave instead of losing it to a single provider.
            // This also covers Brave's free credits running out: its provider
            // swallows API errors and returns empty, and the merge then
            // degrades to SearXNG's results alone.
            const [braveSettled, searxngSettled] = await timeSearch(() =>
              Promise.allSettled([
                searchProvider.search(
                  filledQuery,
                  effectiveMaxResults,
                  effectiveSearchDepthForAPI,
                  include_domains,
                  exclude_domains,
                  {
                    type: type as 'general' | 'optimized',
                    content_types: content_types as SearchContentType[]
                  }
                ),
                createSearchProvider('searxng').search(
                  filledQuery,
                  effectiveMaxResults,
                  effectiveSearchDepthForAPI,
                  include_domains,
                  exclude_domains,
                  {
                    searchMode: search_mode as SearchModeOption,
                    content_types: content_types as SearchContentType[],
                    time_range: toolOptions?.timeRange,
                    intent: toolOptions?.intent,
                    useOllama,
                    ollamaMaxResults
                  }
                )
              ])
            )
            const braveResult =
              braveSettled.status === 'fulfilled' ? braveSettled.value : null
            const searxngResult =
              searxngSettled.status === 'fulfilled'
                ? searxngSettled.value
                : null
            // Which half of the merge actually answered. A silent Brave
            // credit exhaustion degrades to SearXNG-only results that look
            // fine and are quietly narrower, so record it rather than infer
            // it from a count.
            toolTimer?.set(
              'merged',
              [braveResult ? 'brave' : null, searxngResult ? 'searxng' : null]
                .filter(Boolean)
                .join('+') || 'none'
            )
            if (braveSettled.status === 'rejected') {
              console.warn(
                '[search] Brave general failed, continuing with SearXNG:',
                braveSettled.reason
              )
            }
            if (searxngSettled.status === 'rejected') {
              console.warn(
                '[search] SearXNG general failed, continuing with Brave:',
                searxngSettled.reason
              )
            }
            if (!braveResult && !searxngResult) {
              throw braveSettled.status === 'rejected'
                ? braveSettled.reason
                : new Error('Both general search providers failed')
            }
            searchResult = mergeGeneralSearchResults(
              braveResult,
              searxngResult,
              filledQuery
            )
          } else if (searchAPI === 'searxng') {
            // Cached at basic depth: follow-up searches all tier down to
            // basic and previously bypassed the cache entirely, which was the
            // bulk of engine load. Domain filters are part of the key via the
            // query string, and advanced never reaches here (it goes through
            // /api/advanced-search, which has its own cache).
            // Cache outcome is inferred from whether the inner function ran,
            // rather than plumbed out of withBasicSearchCache: that helper
            // only invokes it on a miss, so the flag IS the outcome and no
            // signature change (or its test churn) is needed.
            let providerRan = false
            let providerMs = 0
            searchResult = await withBasicSearchCache(
              basicSearchCacheKey(
                // content_types belongs in the key: it is passed to the provider
                // below and materially changes the request — driving
                // extraCategories -> SearXNG `categories`, the
                // wantsVideo/wantsNews degoog sub-fetches, and the `videos`
                // field. Without it a ['web'] search and a ['video'] search
                // for the same string collide: the second gets the first's
                // cached body, with videos empty and the video-category
                // engines never queried, so the model concludes no video
                // sources exist. Sorted so ['web','video'] and
                // ['video','web'] share one entry rather than two.
                `${filledQuery}|${search_mode}|${include_domains.join(',')}|${exclude_domains.join(',')}|${toolOptions?.intent ?? ''}|${[...((content_types as string[] | undefined) ?? [])].sort().join(',')}`,
                effectiveMaxResults,
                toolOptions?.timeRange
              ),
              async () => {
                providerRan = true
                const startedAt = performance.now()
                try {
                  return await searchProvider.search(
                    filledQuery,
                    effectiveMaxResults,
                    effectiveSearchDepthForAPI,
                    include_domains,
                    exclude_domains,
                    {
                      searchMode: search_mode as SearchModeOption,
                      content_types: content_types as SearchContentType[],
                      time_range: toolOptions?.timeRange,
                      intent: toolOptions?.intent,
                      useOllama,
                      ollamaMaxResults
                    }
                  )
                } finally {
                  // In `finally` so a failing-and-slow fan-out is still
                  // visible in the numbers instead of vanishing.
                  providerMs = performance.now() - startedAt
                }
              },
              redisCacheIO
            )
            toolTimer?.set('cache', providerRan ? 'miss' : 'hit')
            if (providerRan) toolTimer?.mark('search_ms', providerMs)
          } else {
            searchResult = await timeSearch(() =>
              searchProvider.search(
                filledQuery,
                effectiveMaxResults,
                effectiveSearchDepthForAPI,
                include_domains,
                exclude_domains
              )
            )
          }
        }
      } catch (error) {
        console.error('Search API error:', error)
        // A failed search is exactly the case worth measuring — a slow
        // timeout costs the turn the same as a slow success — so emit before
        // rethrowing rather than losing the line.
        toolTimer?.set('error', error instanceof Error ? error.name : 'unknown')
        toolTimer?.emit()
        // Re-throw the error to let AI SDK handle it properly
        throw error instanceof Error ? error : new Error('Unknown search error')
      }

      // Merge expansion-variant results (first search of the turn only):
      // unique URLs appended after the main results so the primary
      // phrasing's ranking stays on top.
      if (variantResultsPromise) {
        // Timed separately because the variants run CONCURRENTLY with the
        // main search: this awaits whatever is still outstanding, so a large
        // variant_wait_ms means the variants — not the main search — set the
        // floor for this tool call.
        const variantStart = performance.now()
        const variantResults = await variantResultsPromise
        toolTimer?.mark('variant_wait_ms', performance.now() - variantStart)
        if (variantResults.length > 0) {
          const seenUrls = new Set((searchResult.results ?? []).map(r => r.url))
          const merged = [...(searchResult.results ?? [])]
          for (const r of variantResults) {
            if (r.url && !seenUrls.has(r.url)) {
              seenUrls.add(r.url)
              merged.push(r)
            }
          }
          const added = merged.length - (searchResult.results?.length ?? 0)
          console.log(
            `[search-expansion] merged ${added} variant results into "${filledQuery}"`
          )
          // Both numbers: `added` alone cannot distinguish "variants found
          // nothing" from "variants found only duplicates", and those imply
          // opposite fixes.
          toolTimer?.set('variant_found', variantResults.length)
          toolTimer?.set('variant_added', added)
          searchResult = { ...searchResult, results: merged }
        }
      }

      // No citationMap is attached: it fully duplicated `results`
      // (citationMap[N] === results[N-1]). The UI derives citations from
      // `results` by index instead (see extractCitationMaps), with a fallback
      // for older persisted messages that still carry citationMap.

      // Add toolCallId from context
      if (context?.toolCallId) {
        searchResult.toolCallId = context.toolCallId
      }

      console.log('completed search')

      // Emitted here, alongside the log line the timeline script keys on, so
      // the structured row and the log-derived timeline always agree.
      if (toolTimer) {
        const counts = countSearchPayload(searchResult)
        toolTimer.set('returned', counts.returned)
        toolTimer.set('images', counts.images)
        toolTimer.set('videos', counts.videos)
        toolTimer.emit()
      }

      logToolPayload('search', query, {
        results: searchResult.results,
        images: searchResult.images
      })

      // Search succeeded — now safe to record this query for future dedup
      // comparisons. Deferred to this point (rather than at the top, before
      // the search ran) so a thrown search never poisons executedQueries: a
      // later identical retry must be allowed to actually run, not get
      // skipped with a "results are already above" note for results that
      // were never produced.
      if (currentQueryEmbedding) {
        executedQueries.push({
          mode: search_mode,
          query,
          embedding: currentQueryEmbedding
        })
      }

      // Yield final results with complete state
      yield {
        state: 'complete' as const,
        ...searchResult
      }
    },
    // Trim the model-facing tool result: state is a streaming marker, and
    // citationMap is no longer produced (dropped defensively for any older
    // persisted output replayed here). images MUST stay — getImageSpecPrompt
    // (lib/render/prompt.ts) instructs the model to embed image URLs verbatim
    // from this array, so stripping them made inline images impossible.
    // toolCallId MUST stay: the prompt cites as [number](#toolCallId), so the
    // model reads the id from here.
    toModelOutput: ({ output }) => {
      if (!output || typeof output !== 'object') {
        return { type: 'json', value: (output ?? null) as JSONValue }
      }
      const modelView: Record<string, unknown> = {
        ...(output as Record<string, unknown>)
      }
      delete modelView.citationMap
      delete modelView.state
      return { type: 'json', value: modelView as JSONValue }
    }
  })
}

// Default export for backward compatibility, using a default model
export const searchTool = createSearchTool('openai:gpt-4o-mini')

// Export type for UI tool invocation
export type SearchUIToolInvocation = UIToolInvocation<typeof searchTool>

export async function search(
  query: string,
  maxResults: number = 10,
  searchDepth: 'basic' | 'advanced' = 'basic',
  includeDomains: string[] = [],
  excludeDomains: string[] = []
): Promise<SearchResults> {
  const result = await searchTool.execute?.(
    {
      query,
      search_mode: 'web',
      type: 'general',
      content_types: ['web'],
      max_results: maxResults,
      search_depth: searchDepth,
      include_domains: includeDomains,
      exclude_domains: excludeDomains
    },
    {
      toolCallId: 'search',
      messages: []
    }
  )

  if (!result) {
    return { results: [], images: [], query, number_of_results: 0 }
  }

  // Handle AsyncIterable case
  if (Symbol.asyncIterator in result) {
    // Collect all results from the async iterable
    let searchResults: SearchResults | null = null
    for await (const chunk of result) {
      // Only assign when we get the complete result
      if ('state' in chunk && chunk.state === 'complete') {
        const { state, ...rest } = chunk
        searchResults = rest as SearchResults
      }
    }
    return (
      searchResults ?? { results: [], images: [], query, number_of_results: 0 }
    )
  }

  return result as SearchResults
}
