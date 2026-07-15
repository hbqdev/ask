import { type JSONValue, tool, UIToolInvocation } from 'ai'

import {
  cosineSimilarity,
  embedTexts,
  getConfiguredModel
} from '@/lib/embeddings/transformers-embedding'
import { getSearchSchemaForModel } from '@/lib/schema/search'
import { SearchResults } from '@/lib/types'
import {
  getGeneralSearchProviderType,
  getSearchToolDescription
} from '@/lib/utils/search-config'
import { getBaseUrlString } from '@/lib/utils/url'
import { logToolPayload } from '@/lib/utils/usage-logging'

import {
  createSearchProvider,
  DEFAULT_PROVIDER,
  SearchProviderType
} from './search/providers'
import type {
  SearchContentType,
  SearchModeOption
} from './search/providers/base'

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
  timeRange: SearchToolOptions['timeRange']
): Promise<SearchResults['results']> {
  const searchAPI =
    (process.env.SEARCH_API as SearchProviderType) || DEFAULT_PROVIDER
  const settled = await Promise.allSettled(
    variants.map(v =>
      createSearchProvider(searchAPI).search(v, 10, 'basic', [], [], {
        time_range: timeRange
      })
    )
  )
  return settled.flatMap(s =>
    s.status === 'fulfilled' ? (s.value.results ?? []) : []
  )
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
              ? searchExpansionVariants(variants, toolOptions.timeRange)
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
      // Mark the turn's first search consumed AFTER resolving its depth, so
      // search #1 gets firstSearchDepth and #2+ tier down. (Dedup-skipped
      // searches return before reaching this point and don't consume it.)
      firstSearchDone = true

      console.log(
        `Using search API: ${searchAPI}, Type: ${type}, Search Depth: ${effectiveSearchDepthForAPI}`
      )

      try {
        if (
          searchAPI === 'searxng' &&
          effectiveSearchDepthForAPI === 'advanced'
        ) {
          // Get the base URL using the centralized utility function
          const baseUrl = await getBaseUrlString()

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
              intent: toolOptions?.intent
            })
          })
          if (!response.ok) {
            throw new Error(
              `Advanced search API error: ${response.status} ${response.statusText}`
            )
          }
          searchResult = await response.json()
        } else {
          // Use the provider factory to get the appropriate search provider
          const searchProvider = createSearchProvider(searchAPI)

          if (searchAPI === 'brave') {
            searchResult = await searchProvider.search(
              filledQuery,
              effectiveMaxResults,
              effectiveSearchDepthForAPI,
              include_domains,
              exclude_domains,
              {
                type: type as 'general' | 'optimized',
                content_types: content_types as SearchContentType[]
              }
            )
          } else if (searchAPI === 'searxng') {
            searchResult = await searchProvider.search(
              filledQuery,
              effectiveMaxResults,
              effectiveSearchDepthForAPI,
              include_domains,
              exclude_domains,
              {
                searchMode: search_mode as SearchModeOption,
                content_types: content_types as SearchContentType[],
                time_range: toolOptions?.timeRange,
                intent: toolOptions?.intent
              }
            )
          } else {
            searchResult = await searchProvider.search(
              filledQuery,
              effectiveMaxResults,
              effectiveSearchDepthForAPI,
              include_domains,
              exclude_domains
            )
          }
        }
      } catch (error) {
        console.error('Search API error:', error)
        // Re-throw the error to let AI SDK handle it properly
        throw error instanceof Error ? error : new Error('Unknown search error')
      }

      // Merge expansion-variant results (first search of the turn only):
      // unique URLs appended after the main results so the primary
      // phrasing's ranking stays on top.
      if (variantResultsPromise) {
        const variantResults = await variantResultsPromise
        if (variantResults.length > 0) {
          const seenUrls = new Set((searchResult.results ?? []).map(r => r.url))
          const merged = [...(searchResult.results ?? [])]
          for (const r of variantResults) {
            if (r.url && !seenUrls.has(r.url)) {
              seenUrls.add(r.url)
              merged.push(r)
            }
          }
          console.log(
            `[search-expansion] merged ${merged.length - (searchResult.results?.length ?? 0)} variant results into "${filledQuery}"`
          )
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
    // Trim the model-facing tool result: images are UI-only thumbnails and
    // state is a streaming marker. citationMap is no longer produced, but we
    // still drop it defensively for any older persisted output replayed through
    // here. toolCallId MUST stay: the prompt cites as [number](#toolCallId), so
    // the model reads the id from here.
    toModelOutput: ({ output }) => {
      if (!output || typeof output !== 'object') {
        return { type: 'json', value: (output ?? null) as JSONValue }
      }
      const modelView: Record<string, unknown> = {
        ...(output as Record<string, unknown>)
      }
      delete modelView.citationMap
      delete modelView.images
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
