// Where each source that survived to the answer ranked BEFORE the crawl.
//
// This is the whole deliverable of the snippet gate's shadow phase: p95 of this
// distribution sets SEARCH_SNIPPET_GATE_TOP_N, and if it comes back high the
// gate does not ship at all. Pure, and separate from route.ts, matching
// lib/telemetry/search-tag.ts — the route itself cannot be unit-tested without mocking
// SearXNG, Crawl4AI and the reranker together.

export function buildReturnedRanks(
  results: { url: string }[],
  rankByUrl: Map<string, number>
): number[] {
  return (
    results
      .map(result => rankByUrl.get(result.url))
      // `!== undefined`, NOT a truthiness check: rank 0 is the best rank and a
      // truthy filter would drop the most important point in the distribution.
      .filter((rank): rank is number => rank !== undefined)
  )
}
