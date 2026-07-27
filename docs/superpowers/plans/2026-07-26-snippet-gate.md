# Pre-Crawl Snippet Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score search candidates on their title+snippet with the cross-encoder
_before_ the crawl, so the expensive Crawl4AI budget is spent on pages likely to
survive the final rerank instead of on whatever order the source merge produced.

**Architecture:** A pure ranking module (`lib/search/snippet-rank.ts`) plus one
call site in `app/api/advanced-search/route.ts` between candidate assembly and
crawl. Behind a three-state flag: `off` (no call at all), `shadow` (score and
log, crawl unchanged), `on` (crawl only the top N). Every failure path falls
back to today's behaviour.

**Tech Stack:** TypeScript, Next.js 16 App Router, Vitest, the self-hosted
cross-encoder at `RERANKER_URL` (`lib/utils/cross-encoder.ts`), the
`StageTimer` telemetry sink (`lib/telemetry/stage-timer.ts`).

**Spec:** `docs/superpowers/specs/2026-07-26-snippet-gate-design.md`

## Global Constraints

- Run tests with `bun run test` — never `bun test` (the latter uses Bun's own
  runner, not Vitest, and will not pick up the project setup files).
- Format with `bunx prettier --write <file>` on individual files — never
  repo-wide `bun run format`.
- Never add `Co-Authored-By` or any AI-attribution trailer to a commit message.
- Do not push to any remote and do not rebuild prod. Staging only.
- The gate must never throw out of the route. Every error path falls back to
  the un-gated candidate list.
- Default `SEARCH_SNIPPET_GATE` is `off`, so a deploy with no env change is a
  no-op.
- Existing suite is green at 1238 passing / 1 skipped as of commit `a2ff7c6`.
  It must stay green.

---

## File Structure

| file                                                             | responsibility                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `lib/search/snippet-rank.ts` (new)                               | Pure ranking + capping. No I/O, no env reads, no network.                        |
| `lib/search/__tests__/snippet-rank.test.ts` (new)                | Unit tests for the above.                                                        |
| `lib/search/snippet-gate.ts` (new)                               | Config reads + the cross-encoder call + fail-open wrapper. The only impure part. |
| `lib/search/__tests__/snippet-gate.test.ts` (new)                | Unit tests for config parsing and fail-open behaviour.                           |
| `app/api/advanced-search/route.ts` (modify)                      | One call site; telemetry emission.                                               |
| `app/api/advanced-search/returned-ranks.ts` (new)                | Pure: maps returned results to their pre-crawl ranks.                            |
| `app/api/advanced-search/__tests__/returned-ranks.test.ts` (new) | Unit tests for the above.                                                        |

The pure/impure split mirrors `lib/search/engine-health.ts` (pure state
machine) against `lib/search/engine-health-store.ts` (Redis plumbing, fails
open). Follow that pattern; do not put env reads or `fetch` in
`snippet-rank.ts`.

---

### Task 1: Pure ranking module

**Files:**

- Create: `lib/search/snippet-rank.ts`
- Test: `lib/search/__tests__/snippet-rank.test.ts`

**Interfaces:**

- Consumes: nothing (this is the base of the feature).
- Produces:
  - `interface RankableCandidate { url: string; title?: string; content?: string }`
  - `interface SnippetRankResult<T extends RankableCandidate> { ranked: T[]; rankByUrl: Map<string, number> }`
  - `buildRankText(candidate: RankableCandidate): string`
  - `rankBySnippetScore<T extends RankableCandidate>(candidates: T[], scores: number[]): SnippetRankResult<T>`
  - `applyCrawlCap<T extends RankableCandidate>(ranked: T[], topN: number, prefetched: Set<string>): T[]`

- [ ] **Step 1: Write the failing tests**

Create `lib/search/__tests__/snippet-rank.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  applyCrawlCap,
  buildRankText,
  rankBySnippetScore
} from '../snippet-rank'

const c = (url: string, title?: string, content?: string) => ({
  url,
  title,
  content
})

describe('buildRankText', () => {
  it('joins title and snippet', () => {
    expect(buildRankText(c('u', 'Title', 'Snippet body'))).toBe(
      'Title\nSnippet body'
    )
  })

  it('tolerates a missing title', () => {
    expect(buildRankText(c('u', undefined, 'Snippet body'))).toBe(
      'Snippet body'
    )
  })

  it('tolerates a missing snippet', () => {
    expect(buildRankText(c('u', 'Title', undefined))).toBe('Title')
  })

  // The cross-encoder rejects empty passages, and a candidate with neither
  // title nor snippet would otherwise send one. Fall back to the URL, which
  // is always present and carries real signal (slug words).
  it('falls back to the url when there is no text at all', () => {
    expect(buildRankText(c('https://example.com/a'))).toBe(
      'https://example.com/a'
    )
  })
})

describe('rankBySnippetScore', () => {
  it('reorders by descending score', () => {
    const { ranked } = rankBySnippetScore(
      [c('a'), c('b'), c('d')],
      [0.1, 0.9, 0.5]
    )
    expect(ranked.map(r => r.url)).toEqual(['b', 'd', 'a'])
  })

  it('reports each url 0-based rank in the new order', () => {
    const { rankByUrl } = rankBySnippetScore(
      [c('a'), c('b'), c('d')],
      [0.1, 0.9, 0.5]
    )
    expect(rankByUrl.get('b')).toBe(0)
    expect(rankByUrl.get('d')).toBe(1)
    expect(rankByUrl.get('a')).toBe(2)
  })

  // A misaligned score array would silently reorder candidates by nonsense.
  // Returning the input untouched is the only safe response.
  it('returns the input order when scores length does not match', () => {
    const { ranked } = rankBySnippetScore([c('a'), c('b')], [0.9])
    expect(ranked.map(r => r.url)).toEqual(['a', 'b'])
  })

  it('preserves merge order for equal scores', () => {
    const { ranked } = rankBySnippetScore(
      [c('a'), c('b'), c('d')],
      [0.5, 0.5, 0.5]
    )
    expect(ranked.map(r => r.url)).toEqual(['a', 'b', 'd'])
  })

  it('returns empty for an empty pool', () => {
    const { ranked, rankByUrl } = rankBySnippetScore([], [])
    expect(ranked).toEqual([])
    expect(rankByUrl.size).toBe(0)
  })
})

describe('applyCrawlCap', () => {
  const pool = [c('a'), c('b'), c('d'), c('e')]

  it('keeps only the first topN', () => {
    expect(applyCrawlCap(pool, 2, new Set()).map(r => r.url)).toEqual([
      'a',
      'b'
    ])
  })

  // Ollama results arrive with full content and are excluded from the crawl
  // anyway, so capping them costs sources for zero time saved.
  it('keeps prefetched urls regardless of rank', () => {
    expect(applyCrawlCap(pool, 2, new Set(['e'])).map(r => r.url)).toEqual([
      'a',
      'b',
      'e'
    ])
  })

  it('does not let prefetched urls consume a cap slot', () => {
    expect(applyCrawlCap(pool, 2, new Set(['a'])).map(r => r.url)).toEqual([
      'a',
      'b',
      'd'
    ])
  })

  it('returns the pool unchanged when topN exceeds its size', () => {
    expect(applyCrawlCap(pool, 99, new Set())).toHaveLength(4)
  })

  it('returns the pool unchanged when topN is zero or negative', () => {
    expect(applyCrawlCap(pool, 0, new Set())).toHaveLength(4)
    expect(applyCrawlCap(pool, -1, new Set())).toHaveLength(4)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- lib/search/__tests__/snippet-rank.test.ts`

Expected: FAIL — `Failed to resolve import "../snippet-rank"`.

- [ ] **Step 3: Write the implementation**

Create `lib/search/snippet-rank.ts`:

```ts
// Pure ranking for the pre-crawl snippet gate. No I/O, no env reads — the
// cross-encoder call and config live in snippet-gate.ts, the same split as
// engine-health.ts against engine-health-store.ts.
//
// Why this exists: app/api/advanced-search/route.ts crawls candidates in
// MERGE order (rank-interleaved per source), not relevance order, and only
// reranks afterwards. On a measured 93-turn sample that meant crawling 32
// pages to return 14, with crawl at 50-70% of the turn.

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
 * resort rather than a normal input: the service rejects empty passages, and
 * a candidate with neither title nor snippet would otherwise send one.
 */
export function buildRankText(candidate: RankableCandidate): string {
  const parts = [candidate.title, candidate.content]
    .map(part => part?.trim())
    .filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join('\n') : candidate.url
}

/**
 * Reorders by descending score. `scores[i]` must correspond to
 * `candidates[i]`; on a length mismatch the ORIGINAL order is returned
 * unchanged, because reordering by a misaligned array is worse than not
 * reordering at all. crossEncoderScore already validates this, so this is the
 * second of two layers.
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- lib/search/__tests__/snippet-rank.test.ts`

Expected: PASS, 15 tests.

- [ ] **Step 5: Format and commit**

```bash
bunx prettier --write lib/search/snippet-rank.ts lib/search/__tests__/snippet-rank.test.ts
git add lib/search/snippet-rank.ts lib/search/__tests__/snippet-rank.test.ts
git commit -m "search: pure ranking module for the pre-crawl snippet gate

Ranking, rank reporting and cap application, with no I/O so it is testable
without a reranker. Two behaviours are load-bearing: a score/candidate length
mismatch returns the input order untouched rather than reordering by a
misaligned array, and prefetched (Ollama) urls bypass the cap because they are
excluded from the crawl anyway and cost nothing to carry."
```

---

### Task 2: Config and fail-open cross-encoder wrapper

**Files:**

- Create: `lib/search/snippet-gate.ts`
- Test: `lib/search/__tests__/snippet-gate.test.ts`

**Interfaces:**

- Consumes: `buildRankText`, `rankBySnippetScore`, `applyCrawlCap`,
  `RankableCandidate`, `SnippetRankResult` from `./snippet-rank` (Task 1);
  `crossEncoderScore(query: string, passages: string[], opts?: { timeoutMs?: number; maxLength?: number }): Promise<number[]>`
  and `isCrossEncoderConfigured(): boolean` from `@/lib/utils/cross-encoder`.
- Produces:
  - `type SnippetGateMode = 'off' | 'shadow' | 'on'`
  - `snippetGateMode(): SnippetGateMode`
  - `snippetGateTopN(): number`
  - `interface SnippetGateOutcome<T> { candidates: T[]; rankByUrl: Map<string, number>; status: 'off' | 'shadow' | 'on' | 'error'; rankMs: number; ranked: number; capped: number }`
  - `runSnippetGate<T extends RankableCandidate>(query: string, candidates: T[], prefetched: Set<string>): Promise<SnippetGateOutcome<T>>`

- [ ] **Step 1: Write the failing tests**

Create `lib/search/__tests__/snippet-gate.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const crossEncoderScore = vi.fn()
const isCrossEncoderConfigured = vi.fn(() => true)

vi.mock('@/lib/utils/cross-encoder', () => ({
  crossEncoderScore: (...args: unknown[]) => crossEncoderScore(...args),
  isCrossEncoderConfigured: () => isCrossEncoderConfigured()
}))

const c = (url: string, title = 't', content = 'body text') => ({
  url,
  title,
  content
})

async function freshModule() {
  vi.resetModules()
  return import('../snippet-gate')
}

describe('snippet gate config', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    crossEncoderScore.mockReset()
    isCrossEncoderConfigured.mockReturnValue(true)
  })
  afterEach(() => vi.unstubAllEnvs())

  it('defaults to off so a deploy with no env change is a no-op', async () => {
    const { snippetGateMode } = await freshModule()
    expect(snippetGateMode()).toBe('off')
  })

  it('reads shadow and on', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'shadow')
    expect((await freshModule()).snippetGateMode()).toBe('shadow')
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'on')
    expect((await freshModule()).snippetGateMode()).toBe('on')
  })

  it('treats an unrecognised value as off', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'yes-please')
    expect((await freshModule()).snippetGateMode()).toBe('off')
  })

  it('defaults topN to 20 and reads an override', async () => {
    expect((await freshModule()).snippetGateTopN()).toBe(20)
    vi.stubEnv('SEARCH_SNIPPET_GATE_TOP_N', '35')
    expect((await freshModule()).snippetGateTopN()).toBe(35)
  })

  it('falls back to 20 for a non-numeric topN', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE_TOP_N', 'lots')
    expect((await freshModule()).snippetGateTopN()).toBe(20)
  })
})

describe('runSnippetGate', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    crossEncoderScore.mockReset()
    isCrossEncoderConfigured.mockReturnValue(true)
  })
  afterEach(() => vi.unstubAllEnvs())

  it('does not call the reranker when off', async () => {
    const { runSnippetGate } = await freshModule()
    const out = await runSnippetGate('q', [c('a'), c('b')], new Set())
    expect(crossEncoderScore).not.toHaveBeenCalled()
    expect(out.status).toBe('off')
    expect(out.candidates.map(r => r.url)).toEqual(['a', 'b'])
  })

  it('scores but does not reorder candidates in shadow mode', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'shadow')
    crossEncoderScore.mockResolvedValue([0.1, 0.9])
    const { runSnippetGate } = await freshModule()
    const out = await runSnippetGate('q', [c('a'), c('b')], new Set())

    expect(crossEncoderScore).toHaveBeenCalledTimes(1)
    expect(out.status).toBe('shadow')
    // Crawl set unchanged — this is what makes shadow safe on prod.
    expect(out.candidates.map(r => r.url)).toEqual(['a', 'b'])
    // But the ranking IS reported.
    expect(out.rankByUrl.get('b')).toBe(0)
    expect(out.ranked).toBe(2)
    expect(out.capped).toBe(0)
  })

  it('reorders and caps in on mode', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'on')
    vi.stubEnv('SEARCH_SNIPPET_GATE_TOP_N', '2')
    crossEncoderScore.mockResolvedValue([0.1, 0.9, 0.5])
    const { runSnippetGate } = await freshModule()
    const out = await runSnippetGate('q', [c('a'), c('b'), c('d')], new Set())

    expect(out.status).toBe('on')
    expect(out.candidates.map(r => r.url)).toEqual(['b', 'd'])
    expect(out.capped).toBe(1)
  })

  it('keeps prefetched urls past the cap in on mode', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'on')
    vi.stubEnv('SEARCH_SNIPPET_GATE_TOP_N', '1')
    crossEncoderScore.mockResolvedValue([0.9, 0.5, 0.1])
    const { runSnippetGate } = await freshModule()
    const out = await runSnippetGate(
      'q',
      [c('a'), c('b'), c('d')],
      new Set(['d'])
    )
    expect(out.candidates.map(r => r.url)).toEqual(['a', 'd'])
  })

  it('falls back to the input order when the reranker throws', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'on')
    vi.stubEnv('SEARCH_SNIPPET_GATE_TOP_N', '1')
    crossEncoderScore.mockRejectedValue(new Error('reranker down'))
    const { runSnippetGate } = await freshModule()
    const out = await runSnippetGate('q', [c('a'), c('b')], new Set())

    expect(out.status).toBe('error')
    // Un-capped: a degraded reranker must never shrink the crawl set.
    expect(out.candidates.map(r => r.url)).toEqual(['a', 'b'])
  })

  it('is off when the reranker is not configured', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'on')
    isCrossEncoderConfigured.mockReturnValue(false)
    const { runSnippetGate } = await freshModule()
    const out = await runSnippetGate('q', [c('a')], new Set())
    expect(crossEncoderScore).not.toHaveBeenCalled()
    expect(out.status).toBe('off')
  })

  it('does not call the reranker for an empty pool', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'shadow')
    const { runSnippetGate } = await freshModule()
    const out = await runSnippetGate('q', [], new Set())
    expect(crossEncoderScore).not.toHaveBeenCalled()
    expect(out.candidates).toEqual([])
  })

  it('passes maxLength 128 and the configured timeout', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'shadow')
    vi.stubEnv('SEARCH_SNIPPET_GATE_TIMEOUT_MS', '1234')
    crossEncoderScore.mockResolvedValue([0.5])
    const { runSnippetGate } = await freshModule()
    await runSnippetGate('q', [c('a')], new Set())
    expect(crossEncoderScore).toHaveBeenCalledWith('q', ['t\nbody text'], {
      maxLength: 128,
      timeoutMs: 1234
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- lib/search/__tests__/snippet-gate.test.ts`

Expected: FAIL — `Failed to resolve import "../snippet-gate"`.

- [ ] **Step 3: Write the implementation**

Create `lib/search/snippet-gate.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- lib/search/__tests__/snippet-gate.test.ts`

Expected: PASS, 14 tests.

- [ ] **Step 5: Format and commit**

```bash
bunx prettier --write lib/search/snippet-gate.ts lib/search/__tests__/snippet-gate.test.ts
git add lib/search/snippet-gate.ts lib/search/__tests__/snippet-gate.test.ts
git commit -m "search: config and fail-open wrapper for the snippet gate

Three modes because shadow has to be deployable to prod with no behaviour
change: off skips the reranker call entirely, shadow scores and reports the
ranking while leaving the crawl set byte-identical, on reorders and caps.

Every failure path returns the un-gated list: unset flag, unconfigured
reranker, empty pool, transport error, timeout. A degraded reranker must never
be the reason the crawl set shrinks."
```

---

### Task 3: Wire into the advanced-search route

**Files:**

- Create: `app/api/advanced-search/returned-ranks.ts`
- Modify: `app/api/advanced-search/route.ts` (insert after the `candidates`
  slice at `:796`; add telemetry after the final slice at `:1081`)
- Test: `app/api/advanced-search/__tests__/returned-ranks.test.ts`

**Interfaces:**

- Consumes: `runSnippetGate(query, candidates, prefetched)` from
  `@/lib/search/snippet-gate` (Task 2), returning `SnippetGateOutcome`.
- Produces:
  - `buildReturnedRanks(results: { url: string }[], rankByUrl: Map<string, number>): number[]`
  - telemetry fields `snippet_gate`, `snippet_rank_ms`, `snippet_ranked`,
    `snippet_capped`, `returned_ranks` on the `[latency:search]` line.

**Convention note:** this route does not get tested through its exported
handler — it needs SearXNG, Crawl4AI and the reranker all mocked. The
established pattern is to extract the pure part into a sibling module and test
that; see `app/api/advanced-search/telemetry-tag.ts` and its test. Follow it.
`buildReturnedRanks` is the only new logic in the route, so it is what gets a
test; the wiring itself is covered by the full suite staying green with the
flag unset, plus the staging check in Task 4.

**Context you need:** `advancedSearchXNGSearch` starts at `:545`. Inside it,
`prefetchedUrls` is built at `:720` from the Ollama results.
`const candidates = generalResults.slice(0, maxResults * SEARXNG_CRAWL_MULTIPLIER)`
is at `:796`. `toEnrich` is built from `candidates` at `:852`. The final
`generalResults = generalResults.slice(0, maxResults)` is at `:1081`. A
`StageTimer` named `timer` is in scope throughout, with `timer.set(name, value)`.

- [ ] **Step 1: Write the failing test**

Create `app/api/advanced-search/__tests__/returned-ranks.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { buildReturnedRanks } from '../returned-ranks'

describe('buildReturnedRanks', () => {
  it('maps each returned url to its pre-crawl rank', () => {
    const ranks = new Map([
      ['https://a.example', 4],
      ['https://b.example', 0],
      ['https://d.example', 7]
    ])
    expect(
      buildReturnedRanks(
        [{ url: 'https://b.example' }, { url: 'https://d.example' }],
        ranks
      )
    ).toEqual([0, 7])
  })

  // Rank 0 is the BEST rank. A truthiness filter would silently drop the
  // single most important data point in the whole distribution.
  it('keeps rank 0', () => {
    expect(
      buildReturnedRanks(
        [{ url: 'https://a.example' }],
        new Map([['https://a.example', 0]])
      )
    ).toEqual([0])
  })

  // Ollama results are merged in after the gate ran, so they legitimately
  // have no pre-crawl rank. Emitting a placeholder would corrupt the p95.
  it('omits urls that were never ranked', () => {
    expect(
      buildReturnedRanks(
        [{ url: 'https://a.example' }, { url: 'https://unranked.example' }],
        new Map([['https://a.example', 2]])
      )
    ).toEqual([2])
  })

  it('returns empty when nothing was ranked', () => {
    expect(
      buildReturnedRanks([{ url: 'https://a.example' }], new Map())
    ).toEqual([])
  })

  it('returns empty for no results', () => {
    expect(buildReturnedRanks([], new Map([['https://a.example', 1]]))).toEqual(
      []
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- app/api/advanced-search/__tests__/returned-ranks.test.ts`

Expected: FAIL — `Failed to resolve import "../returned-ranks"`.

- [ ] **Step 3: Write the helper and add the imports**

Create `app/api/advanced-search/returned-ranks.ts`:

```ts
// Where each source that survived to the answer ranked BEFORE the crawl.
//
// This is the whole deliverable of the snippet gate's shadow phase: p95 of
// this distribution sets SEARCH_SNIPPET_GATE_TOP_N, and if it comes back high
// the gate does not ship at all. Pure, and separate from route.ts, matching
// telemetry-tag.ts — the route itself cannot be unit-tested without mocking
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
```

In `app/api/advanced-search/route.ts`, alongside the other imports near the top:

```ts
import { runSnippetGate } from '@/lib/search/snippet-gate'

import { buildReturnedRanks } from './returned-ranks'
```

- [ ] **Step 4: Insert the gate after the candidate slice**

Replace the block at `:796`:

```ts
const candidates = generalResults.slice(
  0,
  maxResults * SEARXNG_CRAWL_MULTIPLIER
)
```

with:

```ts
const pooledCandidates = generalResults.slice(
  0,
  maxResults * SEARXNG_CRAWL_MULTIPLIER
)

// Pre-crawl relevance gate. `pooledCandidates` is in MERGE order —
// rank-interleaved per source — not relevance order, so without this the
// crawler spends its budget on whatever the merge happened to surface.
// Measured: 32 pages crawled to return 14, with crawl at 50-70% of the
// turn. Fails open to `pooledCandidates` on any error; see snippet-gate.ts.
const gate = await runSnippetGate(query, pooledCandidates, prefetchedUrls)
const candidates = gate.candidates
timer.set('snippet_gate', gate.status)
if (gate.status !== 'off') {
  timer.set('snippet_rank_ms', Math.round(gate.rankMs))
  timer.set('snippet_ranked', gate.ranked)
  timer.set('snippet_capped', gate.capped)
}
```

- [ ] **Step 5: Emit the returned ranks**

Replace the line at `:1081`:

```ts
generalResults = generalResults.slice(0, maxResults)
```

with:

```ts
generalResults = generalResults.slice(0, maxResults)

// Where each source we actually returned ranked BEFORE the crawl. This is
// the entire basis for choosing SEARCH_SNIPPET_GATE_TOP_N, and it is only
// meaningful while the gate still changes nothing — hence shadow mode.
if (snippetRankByUrl.size > 0) {
  timer.set(
    'returned_ranks',
    buildReturnedRanks(generalResults, snippetRankByUrl)
  )
}
```

Then, so `snippetRankByUrl` is in scope at `:1081` (the gate runs inside the
`searchDepth === 'advanced'` block, which closes before this point), declare it
just above the `if (searchDepth === 'advanced') {` line at `:795`:

```ts
let snippetRankByUrl = new Map<string, number>()
```

and assign it inside the gate block added in Step 4, immediately after
`const candidates = gate.candidates`:

```ts
snippetRankByUrl = gate.rankByUrl
```

- [ ] **Step 6: Run the full suite**

Run: `bun run test`

Expected: PASS. 1238 existing + 15 (Task 1) + 14 (Task 2) + 5 (Task 3) = 1272
passing, 1 skipped. If any pre-existing advanced-search test fails, the gate
changed behaviour with the flag unset — that is a bug in Step 4, not a test to
update.

- [ ] **Step 7: Format and commit**

```bash
bunx prettier --write app/api/advanced-search/route.ts \
  app/api/advanced-search/returned-ranks.ts \
  app/api/advanced-search/__tests__/returned-ranks.test.ts
git add app/api/advanced-search/route.ts \
  app/api/advanced-search/returned-ranks.ts \
  app/api/advanced-search/__tests__/returned-ranks.test.ts
git commit -m "search: wire the snippet gate into the advanced path

Runs between candidate assembly and the crawl, and emits returned_ranks - the
pre-crawl rank of every source that survived to the answer. That distribution
is the whole point of phase one: it says whether snippets predict the final
ranking well enough to cap the crawl on, and p95 of it sets TOP_N.

Inert with SEARCH_SNIPPET_GATE unset, so this is a no-op deploy."
```

---

### Task 4: Enable shadow mode on staging and verify

**Files:**

- Modify: `docker-compose.admin-feature.yaml`

**Interfaces:**

- Consumes: `SEARCH_SNIPPET_GATE` read by `snippetGateMode()` (Task 2).
- Produces: `returned_ranks` records accumulating in `latency:log` on
  `ask-redis-admin-feature`.

- [ ] **Step 1: Add the env var**

In `docker-compose.admin-feature.yaml`, in the `ask` service's `environment:`
block, alongside `SEARCH_EXCERPTS_ENABLED`:

```yaml
# Pre-crawl snippet gate, SHADOW: score candidates on title+snippet
# before the crawl and log where each returned source ranked, but crawl
# exactly what we crawl today. Phase 1 of
# docs/superpowers/specs/2026-07-26-snippet-gate-design.md — the
# returned_ranks distribution is what sets TOP_N, and it is only
# trustworthy while the gate changes nothing.
SEARCH_SNIPPET_GATE: 'shadow'
```

- [ ] **Step 2: Rebuild staging**

```bash
docker compose -f docker-compose.yaml -f docker-compose.admin-feature.yaml \
  -f docker-compose.vpn.yaml -f docker-compose.vpn.admin-feature.yaml \
  -p ask-stack-admin-feature up -d --build ask
```

- [ ] **Step 3: Verify it is live and inert**

```bash
until [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://192.168.50.231:3739/)" = "200" ]; do sleep 3; done
docker exec ask-admin-feature printenv SEARCH_SNIPPET_GATE
```

Expected: `200` then `shadow`.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.admin-feature.yaml
git commit -m "staging: run the snippet gate in shadow mode

Scores candidates pre-crawl and records where each returned source ranked,
without changing what gets crawled. Collecting the returned_ranks
distribution that sets TOP_N before anything is allowed to act on it."
```

- [ ] **Step 5: Collect and read the distribution**

Run real turns through the browser at `http://192.168.50.231:3739` — vary the
questions within ONE chat rather than repeating a query in fresh threads. Then:

```bash
docker exec ask-redis-admin-feature redis-cli lrange latency:log 0 -1 \
  | python3 -c "
import sys, json, statistics as st
ranks=[]; turns=0
for line in sys.stdin:
    line=line.strip()
    if not line.startswith('[latency:search]'): continue
    try: rec=json.loads(line.split(' ',1)[1])
    except: continue
    if not rec.get('returned_ranks'): continue
    turns+=1; ranks.extend(rec['returned_ranks'])
if not ranks:
    print('no returned_ranks yet'); raise SystemExit
ranks.sort()
p=lambda q: ranks[min(int(len(ranks)*q), len(ranks)-1)]
print(f'turns={turns}  returned sources={len(ranks)}')
print(f'median={st.median(ranks):.0f}  p75={p(.75)}  p90={p(.90)}  p95={p(.95)}  max={max(ranks)}')
"
```

**Decision rule (from the spec):** need ≥50 turns. Set
`SEARCH_SNIPPET_GATE_TOP_N` to p95. **If p95 > 35, stop — snippets do not
predict the final ranking well enough and Phase 2 does not ship.** Report the
numbers rather than proceeding on a judgement call.

---

## Not in this plan

Phase 2 (flipping staging to `on`, the A/B against prod, and the prod rollout)
is deliberately excluded. It cannot be planned before Phase 1's numbers exist —
`TOP_N` comes from them, and the kill criterion may end the work. Write that
plan once the distribution is in hand.
