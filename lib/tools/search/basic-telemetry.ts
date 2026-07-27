// Telemetry for the searches the [latency:search] line could not see.
//
// Only ONE search per turn reaches /api/advanced-search, which emits its own
// [latency:search] line from inside the route. Every OTHER search — the three
// expansion variants and all follow-ups, which depth tiering forces to basic —
// calls the provider directly from the search tool and emitted nothing at all.
// On a 17-tool-call turn that left ~90% of the searches dark, so any decision
// about capping the tool budget was made on a tenth of the evidence.
//
// These helpers let the tool emit the SAME [latency:search] tag for the paths
// the route never touches. Same tag on purpose: existing analysis greps for
// `[latency:search]` and groups by `depth`, and splitting the tag would mean
// every consumer has to learn about a second one.
//
// The two emitters are told apart by the `provider` field, which only the
// tool-emitted line carries. That matters because the numbers are NOT the same
// measurement: the route line covers search+crawl+rerank but excludes the HTTP
// round trip from the tool, while the tool line brackets everything the tool
// waits for. Comparing a basic total against an advanced total is therefore
// fair; comparing sub-stages across the two is not.

import type { SearchProviderType } from './providers'

/**
 * True when /api/advanced-search will emit the [latency:search] line itself,
 * so the tool must NOT emit a second one for the same search.
 *
 * This is deliberately the same predicate that routes the search in the first
 * place (lib/tools/search.ts): if the two ever drift, a search would be either
 * double-counted or invisible, and both failures are silent. Keep them derived
 * from one expression rather than written twice.
 */
export function routeEmitsSearchTelemetry(
  searchAPI: SearchProviderType,
  depth: 'basic' | 'advanced'
): boolean {
  return searchAPI === 'searxng' && depth === 'advanced'
}

type CountableResults = {
  results?: unknown[]
  images?: unknown[]
  videos?: unknown[]
}

/**
 * Result-shape counts for the emitted line.
 *
 * Every field is optional on SearchResults and providers disagree about which
 * they populate (Brave returns videos, SearXNG only when asked, Tavily never),
 * so a missing array must read as 0 rather than crash the turn it measures.
 */
export function countSearchPayload(
  result: CountableResults | null | undefined
): {
  returned: number
  images: number
  videos: number
} {
  const len = (v: unknown[] | undefined) => (Array.isArray(v) ? v.length : 0)
  return {
    returned: len(result?.results),
    images: len(result?.images),
    videos: len(result?.videos)
  }
}
