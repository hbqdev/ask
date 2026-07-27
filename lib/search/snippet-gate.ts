// Config + cross-encoder call for the pre-crawl snippet gate. The ranking
// itself is pure and lives in snippet-rank.ts.
//
// Everything here fails OPEN. A degraded reranker must never shrink the crawl
// set — the gate is an optimisation, not a correctness requirement, and its
// worst outcome must be "today's behaviour". Same contract as
// engine-health-store.ts.

import {
  crossEncoderScore,
  isCrossEncoderConfigured
} from '@/lib/utils/cross-encoder'

import {
  applyCrawlCap,
  buildRankText,
  type RankableCandidate,
  rankBySnippetScore
} from './snippet-rank'

export type SnippetGateMode = 'off' | 'shadow' | 'on'

const DEFAULT_TOP_N = 20
// Above the measured 80-snippet worst case of 3,305 ms (the pool is capped at
// maxResults * SEARXNG_CRAWL_MULTIPLIER = 80 and medians 40), with headroom.
const DEFAULT_TIMEOUT_MS = 4_500
// Snippets run 30-60 words. 128 matches the reranker service default and the
// benchmark the spec's cost figures come from.
const RANK_MAX_LENGTH = 128

export function snippetGateMode(): SnippetGateMode {
  const raw = process.env.SEARCH_SNIPPET_GATE
  return raw === 'shadow' || raw === 'on' ? raw : 'off'
}

export function snippetGateTopN(): number {
  const parsed = parseInt(process.env.SEARCH_SNIPPET_GATE_TOP_N || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOP_N
}

function snippetGateTimeoutMs(): number {
  const parsed = parseInt(process.env.SEARCH_SNIPPET_GATE_TIMEOUT_MS || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

export interface SnippetGateOutcome<T> {
  /** What to crawl. In `off`/`shadow`/`error` this is the input, untouched. */
  candidates: T[]
  /** url -> pre-crawl rank. Empty unless scoring succeeded. */
  rankByUrl: Map<string, number>
  status: 'off' | 'shadow' | 'on' | 'error'
  rankMs: number
  ranked: number
  capped: number
}

export async function runSnippetGate<T extends RankableCandidate>(
  query: string,
  candidates: T[],
  prefetched: Set<string>
): Promise<SnippetGateOutcome<T>> {
  const inert: SnippetGateOutcome<T> = {
    candidates,
    rankByUrl: new Map(),
    status: 'off',
    rankMs: 0,
    ranked: 0,
    capped: 0
  }

  const mode = snippetGateMode()
  if (mode === 'off') return inert
  if (candidates.length === 0) return inert
  if (!isCrossEncoderConfigured()) return inert

  const startedAt = performance.now()
  try {
    const scores = await crossEncoderScore(
      query,
      candidates.map(buildRankText),
      { maxLength: RANK_MAX_LENGTH, timeoutMs: snippetGateTimeoutMs() }
    )
    const { ranked, rankByUrl } = rankBySnippetScore(candidates, scores)
    const rankMs = performance.now() - startedAt

    if (mode === 'shadow') {
      // Report the ranking, change nothing. This is the property that makes
      // shadow safe to run on prod.
      return {
        candidates,
        rankByUrl,
        status: 'shadow',
        rankMs,
        ranked: candidates.length,
        capped: 0
      }
    }

    const capped = applyCrawlCap(ranked, snippetGateTopN(), prefetched)
    return {
      candidates: capped,
      rankByUrl,
      status: 'on',
      rankMs,
      ranked: candidates.length,
      capped: candidates.length - capped.length
    }
  } catch (error) {
    console.warn(
      '[snippet-gate] scoring failed, crawling the un-gated candidate list:',
      error
    )
    return {
      ...inert,
      status: 'error',
      rankMs: performance.now() - startedAt
    }
  }
}
