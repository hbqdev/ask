// Pure ranking for the pre-crawl snippet gate. No I/O, no env reads — the
// cross-encoder call and config live in snippet-gate.ts, the same split as
// engine-health.ts against engine-health-store.ts.
//
// Why this exists: app/api/advanced-search/route.ts crawls candidates in MERGE
// order (rank-interleaved per source), not relevance order, and only reranks
// afterwards. On a measured 93-turn sample that meant crawling 32 pages to
// return 14, with crawl at 50-70% of the turn.

export interface RankableCandidate {
  url: string
  title?: string
  content?: string
}

export interface SnippetRankResult<T extends RankableCandidate> {
  /** Candidates reordered by descending snippet score. */
  ranked: T[]
  /** url -> 0-based rank within `ranked`. Basis for the shadow telemetry. */
  rankByUrl: Map<string, number>
}

/**
 * Text handed to the cross-encoder for one candidate. The URL is the last
 * resort rather than a normal input: the service rejects empty passages, and a
 * candidate with neither title nor snippet would otherwise send one.
 */
export function buildRankText(candidate: RankableCandidate): string {
  const parts = [candidate.title, candidate.content]
    .map(part => part?.trim())
    .filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join('\n') : candidate.url
}

/**
 * Reorders by descending score. `scores[i]` must correspond to `candidates[i]`;
 * on a length mismatch the ORIGINAL order is returned unchanged, because
 * reordering by a misaligned array is worse than not reordering at all.
 * crossEncoderScore already validates this, so this is the second of two layers.
 *
 * Sort is stable (Array.prototype.sort is spec-stable), so equal scores keep
 * merge order.
 */
export function rankBySnippetScore<T extends RankableCandidate>(
  candidates: T[],
  scores: number[]
): SnippetRankResult<T> {
  const ordered =
    scores.length === candidates.length
      ? candidates
          .map((candidate, index) => ({ candidate, score: scores[index] }))
          .sort((a, b) => b.score - a.score)
          .map(entry => entry.candidate)
      : candidates.slice()

  const rankByUrl = new Map<string, number>()
  ordered.forEach((candidate, index) => {
    if (!rankByUrl.has(candidate.url)) rankByUrl.set(candidate.url, index)
  })

  return { ranked: ordered, rankByUrl }
}

/**
 * Applies the crawl cap to a ranked list. Prefetched URLs (Ollama, already
 * full-content) are always kept and do NOT consume a slot — they are excluded
 * from the crawl anyway, so capping them loses sources for no time saved.
 *
 * `topN <= 0` is treated as "no cap" so a misconfigured env var degrades to
 * today's behaviour instead of crawling nothing.
 */
export function applyCrawlCap<T extends RankableCandidate>(
  ranked: T[],
  topN: number,
  prefetched: Set<string>
): T[] {
  if (topN <= 0) return ranked
  let budget = topN
  return ranked.filter(candidate => {
    if (prefetched.has(candidate.url)) return true
    if (budget > 0) {
      budget -= 1
      return true
    }
    return false
  })
}
