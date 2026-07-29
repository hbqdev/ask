// The ADVANCED search path, callable from anywhere.
//
// "advanced" is not a depth flag a provider understands — it is a different
// pipeline that lives behind /api/advanced-search: fan-out to SearXNG (plus
// the degoog/Ollama/Brave/Tavily merges), Crawl4AI crawl of the candidates,
// snippet gate, cross-encoder rerank, and full (or excerpted) page content in
// the response. `createSearchProvider('searxng').search(q, n, 'advanced', …)`
// does NONE of that: the provider ignores the depth argument entirely and
// returns raw engine snippets of 100-300 chars.
//
// This module exists because TWO callers need that pipeline — the `search`
// tool's first search of a turn, and the pipeline architecture's single
// retrieval (lib/agents/flows/pipeline.ts). The logic used to live inline
// inside the tool's execute(), which is exactly why the second caller was
// written against the provider and silently got snippets: there was nothing
// to reuse. Keep it here so a change to how the route is called reaches both.

import type { SearchResultItem, SearchResults } from '@/lib/types'
import { readNdjson } from '@/lib/utils/ndjson'
import { isOllamaSearchConfigured } from '@/lib/utils/ollama-search-client'
import { getBaseUrlString } from '@/lib/utils/url'

import type { SearchIntent } from './intent'

// Ollama's web-search API clamps max_results to 10 server-side (verified by
// requesting 20/50/100 and getting exactly 10 each time). Asking for more is
// silently ignored, so the value is clamped here instead — an operator who
// sets OLLAMA_SEARCH_MAX_RESULTS=50 should see 10, not believe they get 50.
const OLLAMA_SEARCH_HARD_MAX = 10

export type AdvancedSearchParams = {
  query: string
  maxResults: number
  searchDepth: 'basic' | 'advanced'
  includeDomains?: string[]
  excludeDomains?: string[]
  timeRange?: 'day' | 'week' | 'month' | 'year'
  intent?: SearchIntent
  /**
   * Forwarded purely so the route's [latency:search] line can be joined to the
   * turn's [latency] line. Turns make multiple searches, so ordering does not
   * identify them.
   */
  chatId?: string
  useOllama?: boolean
  ollamaMaxResults?: number
  /**
   * Ask the route for the NDJSON preview stream. Defaults to
   * SEARCH_STREAM_PREVIEW (on unless explicitly 'false'). Callers with nowhere
   * to put a preview — the pipeline retrieval fires before the UI stream even
   * exists — pass false and get a single JSON response instead.
   */
  stream?: boolean
}

export type AdvancedSearchMessage =
  | { type: 'preview'; results: SearchResults }
  | { type: 'final'; results: SearchResults; fullResults?: SearchResultItem[] }

/**
 * Whether this deployment adds Ollama web-search to a search, and how many
 * results to ask it for.
 *
 * Shared rather than inlined because both callers of the advanced route have
 * to agree: a retrieval that omitted `useOllama` would quietly lose the one
 * source that returns full page content AND would miss the prefetch that stops
 * Crawl4AI re-fetching those pages.
 *
 * Unlike every other source, raising the count REDUCES work. Ollama returns
 * full page content (~10k chars per result) and its URLs are the only ones
 * added to prefetchedUrls — so the crawler skips them. Five more results here
 * are five fewer pages Crawl4AI has to fetch, and crawl is 55-70% of turn
 * latency. Metering is per REQUEST, not per result, so asking for 5 and asking
 * for 10 are the same call at the same price.
 */
export function resolveOllamaSearchOptions(): {
  useOllama: boolean
  ollamaMaxResults: number
} {
  const raw = Number(process.env.OLLAMA_SEARCH_MAX_RESULTS)
  return {
    useOllama:
      isOllamaSearchConfigured() && process.env.OLLAMA_SEARCH_ENABLED !== 'off',
    ollamaMaxResults:
      Number.isFinite(raw) && raw > 0
        ? Math.min(raw, OLLAMA_SEARCH_HARD_MAX)
        : OLLAMA_SEARCH_HARD_MAX
  }
}

/**
 * Run one advanced search, yielding the route's NDJSON messages as they land.
 *
 * A `preview` is the merged fan-out BEFORE crawl and rerank (~2s in); the
 * `final` is the crawled and reranked payload (~15-20s in). Callers that can
 * render a preview should; callers that cannot should use runAdvancedSearch.
 *
 * Throws on a non-OK response and on a stream that ends without a final line —
 * a caller must never silently treat "the route died" as "no results".
 */
export async function* streamAdvancedSearch(
  params: AdvancedSearchParams
): AsyncGenerator<AdvancedSearchMessage> {
  // Default ON: the preview is strictly additive (an extra UI-only yield), and
  // the final line is identical to the non-streaming response.
  const wantsStream =
    params.stream ??
    (process.env.SEARCH_STREAM_PREVIEW !== 'false' &&
      typeof ReadableStream !== 'undefined')

  const baseUrl = await getBaseUrlString()
  const response = await fetch(`${baseUrl}/api/advanced-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: params.query,
      maxResults: params.maxResults,
      searchDepth: params.searchDepth,
      includeDomains: params.includeDomains ?? [],
      excludeDomains: params.excludeDomains ?? [],
      timeRange: params.timeRange,
      intent: params.intent,
      chatId: params.chatId,
      useOllama: params.useOllama,
      ollamaMaxResults: params.ollamaMaxResults,
      stream: wantsStream
    })
  })

  if (!response.ok) {
    throw new Error(
      `Advanced search API error: ${response.status} ${response.statusText}`
    )
  }

  if (wantsStream && response.body) {
    let sawFinal = false
    for await (const line of readNdjson(response.body)) {
      const msg = line as { type?: string } & Partial<SearchResults> & {
          fullResults?: SearchResultItem[]
        }
      if (msg?.type === 'preview') {
        yield {
          type: 'preview',
          results: {
            results: msg.results ?? [],
            query: msg.query ?? params.query,
            images: msg.images ?? [],
            number_of_results: msg.number_of_results ?? 0
          }
        }
      } else if (msg?.type === 'final') {
        sawFinal = true
        yield {
          type: 'final',
          results: {
            results: msg.results ?? [],
            query: msg.query ?? params.query,
            images: msg.images ?? [],
            number_of_results: msg.number_of_results ?? 0
          },
          fullResults: msg.fullResults
        }
      }
    }
    if (!sawFinal) {
      throw new Error('Advanced search stream ended with no final line')
    }
    return
  }

  // Non-streaming: the body IS the SearchResults payload. Passed through whole
  // (rather than re-projected field by field) so this branch keeps behaving
  // exactly as it did when it lived in the search tool.
  const body = await response.json()
  yield {
    type: 'final',
    results: body as SearchResults,
    fullResults: (body as { fullResults?: SearchResultItem[] })?.fullResults
  }
}

/**
 * Advanced search for callers with nowhere to put a preview: drains the
 * stream and returns only the final payload.
 */
export async function runAdvancedSearch(
  params: AdvancedSearchParams
): Promise<{ results: SearchResults; fullResults?: SearchResultItem[] }> {
  let final: {
    results: SearchResults
    fullResults?: SearchResultItem[]
  } | null = null
  for await (const msg of streamAdvancedSearch(params)) {
    if (msg.type === 'final') {
      final = { results: msg.results, fullResults: msg.fullResults }
    }
  }
  if (!final) throw new Error('Advanced search returned no final result')
  return final
}
