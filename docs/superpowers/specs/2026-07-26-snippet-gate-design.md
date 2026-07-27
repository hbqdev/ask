# Pre-Crawl Snippet Gate — Design

**Date:** 2026-07-26
**Status: NOT SHIPPED — measured, rejected 2026-07-27.**

The gate works exactly as designed and makes turns **~3.2s slower**. Capping the
crawl from 50 to 40 pages saved 184 ms, against the gate's own 2,613 ms cost.
The premise — that crawl time is steeply superlinear in page count — did not
survive direct manipulation. See "Phase 2 results" and "What this got wrong".

The code is committed and inert (`SEARCH_SNIPPET_GATE` unset ⇒ no reranker call
at all). It is kept, not reverted, because the `returned_ranks` telemetry is
useful for any future work on source selection, and because the measurement
harness is the expensive part to rebuild. Everything below the Phase 2 results
is the original design, left as written so the reasoning that led here is
legible.

## Goal

Cut prompt→answer latency by crawling fewer, better-chosen pages, with no loss
of answer quality.

The pipeline owns a relevance oracle (the cross-encoder at `RERANKER_URL`) and
an expensive fetch (Crawl4AI), and today it runs them in that order: crawl
everything, then rank. This spec inserts a cheap ranking pass **before** the
crawl so the expensive budget is spent on pages likely to survive it.

## Evidence

All figures measured 2026-07-26 from `latency:log` on staging
(`ask-redis-admin-feature`), n=93 advanced-depth cache-miss searches, and from
direct benchmarks against the reranker at `192.168.50.17:8787`.

### We crawl roughly twice what we return

| stage       | median |   mean |
| ----------- | -----: | -----: |
| candidates  |     40 |   44.5 |
| crawled     |     32 |   35.8 |
| rerank_docs |     21 |   22.0 |
| returned    |     14 |   13.1 |
| crawl_ms    | 15,912 | 23,904 |
| rerank_ms   |  9,430 |  9,686 |
| total_ms    | 31,841 | 42,193 |

`crawl_ms` is 50–70% of a turn. About 18 pages per turn are rendered in full
and then discarded.

The cause is ordering, not sizing. `app/api/advanced-search/route.ts:796` takes

```ts
const candidates = generalResults.slice(
  0,
  maxResults * SEARXNG_CRAWL_MULTIPLIER
)
```

which is **merge order** — rank-interleaved per source by `merge-degoog.ts`,
`merge-tavily.ts`, `merge-brave.ts` — not relevance order against the query.
Every candidate is then crawled (`:852`), and only afterwards does the
cross-encoder see them.

### Crawl cost is superlinear in page count

Chunks run fully in parallel; `crawl_ms` is simply the slowest chunk:

```
corr(slowest_chunk_ms, crawl_ms) = +0.991     crawl_ms / slowest_chunk_ms = 1.00 (median)
corr(median_chunk_ms,  crawl_ms) = +0.958     slowest_chunk / median_chunk = 1.04 (median)
corr(crawled,          crawl_ms) = +0.501
```

Chunk duration is not constant, because the Crawl4AI sidecar's process pool
saturates as more chunks are in flight:

| pages crawled |   n | median crawl_ms |
| ------------- | --: | --------------: |
| 10–19         |  14 |           8,658 |
| 20–29         |  26 |          10,926 |
| 30–39         |  16 |          12,102 |
| 40–49         |  12 |          21,348 |
| 50–59         |  17 |          25,695 |
| 60–69         |   7 |          53,712 |

39% of turns (36/93) crawl 40 or more pages. Those turns are the 30–110s
outliers that drag `total_ms` mean (42.2s) far above its median (31.8s).

### Snippet-level scoring is cheap enough to pay for itself

Benchmarked directly against the reranker (3 runs each, median reported, after
a warm-up call):

| workload                                    |       median |   min |   max |
| ------------------------------------------- | -----------: | ----: | ----: |
| 40 snippets, ~40w, `max_length` 128         | **1,651 ms** | 1,645 | 1,678 |
| 60 snippets, ~40w, `max_length` 128         |     2,456 ms | 2,443 | 2,457 |
| 80 snippets, ~40w, `max_length` 128         |     3,305 ms | 3,291 | 3,315 |
| _(today)_ 21 pages, ~900w, `max_length` 512 |     3,462 ms | 3,453 | 3,525 |
| _(today)_ 32 pages, ~900w, `max_length` 512 |     5,353 ms | 5,337 | 5,363 |

Scoring the median 40-candidate pool costs **1.65s**. Moving that pool's crawl
from the 30–39 bucket to the 10–19 bucket saves ~3.4s on the median turn and
~15–45s on the 40+ page turns.

## Non-goal: gating Tavily and Brave

The original framing was to skip Tavily/Brave when SearXNG and degoog already
look sufficient. The measurements say this is the wrong lever and it is
deliberately **not** part of this design:

- Both are issued inside the same `Promise.allSettled` as SearXNG
  (`route.ts:614-656`) and complete before it. They add no measurable latency.
- Quota is not scarce: 30/950 Tavily and 14/2000 Brave on prod for July 2026,
  96/950 and 64/2000 on staging. Both budgets are enforced in Redis
  (`route.ts:266`, `:305`) and fail closed if Redis is unavailable.
- They are block-immune — they run on vendor IPs, not ours. A "SearXNG results
  look good enough" heuristic would skip them most reliably in exactly the
  situation where SearXNG is being throttled or CAPTCHA'd and they are most
  needed.

Sources are near-free to query in parallel. The cost is crawling what they
return, so the crawl set is where the work belongs.

## Architecture

One new stage between candidate assembly and the crawl, plus telemetry that
makes its effect measurable before it is allowed to change anything.

```
fan-out (searxng + degoog + tavily + brave + ollama)     ~2.1s, parallel
  → merge → candidates = slice(0, maxResults × 4)              [unchanged]
  → NEW snippet gate: crossEncoder(query, title+snippet, max_length 128)   ~1.7s
        shadow → record url→rank map, crawl everything as today
        on     → candidates = top-N by snippet score (+ all prefetched)
  → crawl (Crawl4AI)                                  ~15.9s → target ~8.7s
  → quality filter → full-page cross-encoder rerank → returned
  → NEW emit returned_ranks: pre-crawl rank of each returned URL
```

The existing full-page rerank is untouched and remains the final authority on
what is returned. This stage only decides what is worth fetching.

## Components

### `lib/search/snippet-rank.ts` (new)

Pure, no I/O, no env reads. Everything decidable without the network lives
here so it is unit-testable in isolation — the same split used by
`lib/search/engine-health.ts` against its Redis store.

```ts
export interface RankableCandidate {
  url: string
  title?: string
  content?: string
}

export interface SnippetRankResult<T extends RankableCandidate> {
  /** Candidates reordered by descending snippet score. */
  ranked: T[]
  /** url -> 0-based rank within `ranked`. Used for shadow telemetry. */
  rankByUrl: Map<string, number>
}

/** Text handed to the cross-encoder for one candidate: title + snippet. */
export function buildRankText(candidate: RankableCandidate): string

/**
 * Reorders by score. `scores[i]` must correspond to `candidates[i]`; on a
 * length mismatch the original order is returned unchanged (fail-open).
 * Sort is stable, so equal scores preserve merge order.
 */
export function rankBySnippetScore<T extends RankableCandidate>(
  candidates: T[],
  scores: number[]
): SnippetRankResult<T>

/**
 * Applies the crawl cap. `prefetched` URLs (Ollama, already full-content)
 * are always kept regardless of rank and do not consume a slot, since they
 * are excluded from the crawl anyway and cost nothing to carry.
 * `topN <= 0` returns the input unchanged.
 */
export function applyCrawlCap<T extends RankableCandidate>(
  ranked: T[],
  topN: number,
  prefetched: Set<string>
): T[]
```

### Cross-encoder call

Reuses `crossEncoderScore` from `lib/utils/cross-encoder.ts` with
`maxLength: 128`. No new service and no new client. The 128 cap matches the
service default and the benchmark above; snippets are 30–60 words, so nothing
is truncated in practice.

### Route integration

In `app/api/advanced-search/route.ts`, inside the `searchDepth === 'advanced'`
branch, after `candidates` is sliced (`:796`) and before `toEnrich` is built
(`:852`).

## Configuration

| variable                         | values                    | default | meaning                         |
| -------------------------------- | ------------------------- | ------- | ------------------------------- |
| `SEARCH_SNIPPET_GATE`            | `off` \| `shadow` \| `on` | `off`   | stage mode                      |
| `SEARCH_SNIPPET_GATE_TOP_N`      | integer                   | `20`    | crawl cap when `on`             |
| `SEARCH_SNIPPET_GATE_TIMEOUT_MS` | integer                   | `4500`  | scoring budget before fail-open |

Three modes rather than a boolean because `shadow` must be deployable to prod
without any behavior change. `off` skips the cross-encoder call entirely, so
the feature costs nothing when disabled.

The pool is capped at `maxResults × 4` = 80 and medians 40, so the timeout has
to clear the measured 80-snippet worst case of 3,305 ms, not the 40-snippet
median of 1,651 ms. 4,500 ms leaves ~35% headroom over that worst case. If it
is being hit regularly that is a signal the reranker is degraded, and
fail-open is the correct response either way.

## Error handling

Fail-open at every step. A degraded reranker must never make search worse than
not having this feature:

- Cross-encoder throws, times out, or returns a malformed/mismatched score
  array → skip the gate, crawl the candidate list exactly as today, and emit
  `snippet_gate: 'error'` in telemetry.
- `crossEncoderScore` already validates `scores.length === passages.length`
  (`cross-encoder.ts:57`), and `rankBySnippetScore` re-checks and returns the
  input order on mismatch — two layers, because a silent misalignment would
  reorder candidates by nonsense scores rather than fail loudly.
- The gate never throws out of the route. It is wrapped and its failure is
  logged, not propagated.

This mirrors the contract established by the engine health gate
(`lib/search/engine-health-store.ts`): best-effort signal, zero ability to
break the search.

## Telemetry

New fields on the existing `[latency:search]` line, which already lands in the
durable Redis sink at `latency:log` (`lib/telemetry/latency-store.ts`):

| field             | type     | meaning                                     |
| ----------------- | -------- | ------------------------------------------- |
| `snippet_gate`    | string   | `off` \| `shadow` \| `on` \| `error`        |
| `snippet_rank_ms` | number   | wall time of the scoring call               |
| `snippet_ranked`  | number   | candidates scored                           |
| `returned_ranks`  | number[] | pre-crawl rank of each finally-returned URL |
| `snippet_capped`  | number   | candidates dropped by the cap (`on` only)   |

`returned_ranks` is the load-bearing one: it is the entire basis for choosing
N, and it is only meaningful because it is captured while the gate still
changes nothing.

## Testing

**Unit — `lib/search/__tests__/snippet-rank.test.ts`:**

- reorders by descending score
- returns input order unchanged when `scores.length !== candidates.length`
- stable for equal scores (merge order preserved)
- empty candidate list returns empty, does not throw
- `buildRankText` joins title and snippet, tolerates either being absent
- `applyCrawlCap` keeps all prefetched URLs regardless of rank
- `applyCrawlCap` with `topN` ≥ pool size returns the pool unchanged
- `applyCrawlCap` with `topN <= 0` returns the pool unchanged

**Route — extend the existing advanced-search suite:**

- `shadow` mode: the set of URLs passed to `crawl4aiScrapeMany` is byte-identical
  to `off` mode for the same input. This is the property that makes Phase 1 safe
  on prod, so it is asserted directly rather than inferred.
- `shadow` mode emits `returned_ranks` with one entry per returned result.
- cross-encoder rejection → crawl set identical to `off`, `snippet_gate: 'error'`.
- `on` mode passes at most `TOP_N` non-prefetched URLs to the crawler.
- `on` mode still passes every prefetched URL through to the result pool.

Existing suite must stay green: 1238 passing as of `85e3be2`.

## Phases

### Phase 1 — Shadow

Ship the module, the route hook, and the telemetry. Deploy `shadow` to staging
and prod. Behavior is provably unchanged; the only cost is one ~1.7s
cross-encoder call per advanced search, which runs while nothing else is
blocked on it.

**Exit criterion:** enough advanced-depth turns for the retention curve to
converge. Set `SEARCH_SNIPPET_GATE_TOP_N` to the smallest N retaining ≥95% of
returned sources.

**Kill criterion (corrected 2026-07-27):** if the smallest N retaining 95% of
returned sources exceeds **75% of the median pool size**, snippets are not
predictive enough to spend the crawl budget on and Phase 2 does not ship.

The original criterion was an absolute rank — "if p95 of `returned_ranks`
exceeds ~35" — and it was wrong. It was written against the then-current pool
median of 40 candidates, so 35 meant "the bottom 12% of the pool". Re-enabling
degoog on the advanced path the same day pushed the pool median to 60, at which
point the identical number silently meant "the bottom 42%". The threshold moved
without the question changing. A fraction of pool size is the invariant; an
absolute rank is not.

Two further corrections to how the exit number is read:

- **p95 of the raw rank is meaningless when pool size varies.** Observed pools
  ranged 40–80 within one session, so rank 30 is "top 75%" in one turn and "top
  38%" in another. Use the retention curve — for each candidate N, what share of
  the sources that actually reached the answer would still have been crawled.
- **Retention is not quality.** Keeping 95% of source URLs does not prove the
  answers hold up; the dropped 5% may be load-bearing on some queries. Only the
  Phase 2 A/B settles that, which is why Phase 2 measures answers and not just
  counts.

### Phase 1 results (measured 2026-07-27, staging, n=17 turns / 227 sources)

Converged: checkpoints at 7, 10, 14 and 17 turns agree within ~1pp at every N.
Pool median 60 (min 40, max 80). Gate cost `snippet_rank_ms` median 2,725 ms.

|  TOP_N | sources kept | turns fully covered | crawl pages | est. crawl saved |        net |
| -----: | -----------: | ------------------: | ----------: | ---------------: | ---------: |
|     20 |        58.6% |                  6% |     55 → 18 |                — |          — |
|     30 |        82.4% |                 29% |     55 → 28 |            14.8s |     +12.0s |
|     35 |        90.3% |                 53% |     55 → 32 |            13.6s |     +10.9s |
| **40** |    **95.2%** |                 59% | **55 → 37** |        **13.6s** | **+10.9s** |
|     45 |        97.8% |                   — |     55 → 41 |             4.3s |      +1.6s |
|     50 |        98.7% |                 88% |           — |                — |          — |

N=40 is the knee: 95% retention, ~10.9s net. N=45 buys 2.6pp more retention for
9s of the saving. 40 is 67% of the median pool, inside the corrected threshold
of 75%.

Crawl savings above are **estimated** by projecting each turn's reduced page
count onto the measured page-count/`crawl_ms` bucket curve. Phase 2 replaces
them with measurements.

### Phase 2 — Enforce

Flip staging to `on` with N from Phase 1. Prod follows only after the A/B.

**Success criteria:**

- `crawl_ms` median falls materially — from the shadow baseline of 20.5s at 55
  pages toward the 30–39 page bucket (~12.1s)
- `returned` count unchanged (shadow baseline median 13, and the 20 cap still
  reachable)
- fixed-question A/B, staging vs prod, surfaces the same sources
- net saving beats the gate's own cost: the median turn must improve by more
  than the measured 1.65s

### Phase 2 results (measured 2026-07-27, staging) — FAILED

`off` vs `on` (TOP_N=40), same 17 questions, search cache cleared before each
arm, exit IP rotated and engine health cleared before each arm. off n=14 (three
turns tiered to basic and produced no advanced record), on n=17.

| metric          |        OFF |         ON |      delta |
| --------------- | ---------: | ---------: | ---------: |
| candidates      |         56 |         45 |        −10 |
| crawled         |         50 |         40 |        −10 |
| **crawl_ms**    |     17,995 |     17,811 |   **−184** |
| snippet_rank_ms |          — |      2,613 |     +2,613 |
| rerank_ms       |      9,210 |      7,945 |     −1,266 |
| **returned**    |     **14** |     **14** |      **0** |
| **total_ms**    | **30,110** | **33,279** | **+3,170** |

Mean `total_ms` 34,634 → 33,854 (−780); the mean improves only because of tail
turns, while the median — the typical turn — gets materially worse.

The ledger: spend 2.6s scoring, recover 1.3s of rerank and 0.2s of crawl.

`returned` is identical, so there was no quality cost. There was no quality
benefit either. The gate is simply slower.

## What this got wrong

**A cross-sectional correlation was treated as a response curve.** The design
rests on bucketing 93 historical turns by page count and reading off a steep
crawl_ms curve (10–19 pages → 8.7s, 60–69 → 53.7s). That correlation is real
but not causal: turns that crawl more pages are also turns with harder queries,
more marginal domains and slower pages. Cutting the page count directly does
not walk backwards down that curve — measured, 10 fewer pages bought 184 ms.

The check that would have caught it is cheap and was never run: force a lower
`MAX_ENRICH_URLS` for a few turns and measure `crawl_ms` before building
anything. One flag, no new code. Instead the curve was carried through a spec,
a plan, four commits and three measurement arms.

**The first A/B compared the wrong baseline.** shadow→on was reported as
−4.56s, but shadow also pays the full scoring cost — it scores and declines to
act. That comparison isolates the benefit of capping while holding the gate's
cost constant in both arms, so it cannot answer "is the gate worth having".
Only off→on can, and it reverses the sign.

**Engine blocking was not checked until after results were reported.** The
first two arms ran while our own load was suspending engines (276 CAPTCHA/403
signals, 8 engines suspended mid-run), so part of the `candidates` drop
attributed to the cap was engines dropping out. Engine health belongs in the
pre-flight of any search A/B, not the post-mortem.

**Two projections in this document were wrong by 5×–70×** and are retained
above with their errors marked rather than deleted: 13.6s projected crawl
saving vs 184 ms measured. Projections onto a bucket curve should not have been
written in units that look like measurements.

## What is kept

- `lib/search/snippet-rank.ts`, `lib/search/snippet-gate.ts`,
  `app/api/advanced-search/returned-ranks.ts` and their tests — inert with the
  flag unset, no reranker call, no cost.
- `returned_ranks` telemetry, which is the only direct evidence we have about
  how well pre-crawl signals predict what survives to an answer.
- `fleet-boot/rotate-mullvad.sh` and the gluetun control-server auth, which came
  out of this work and are independently useful.

## Where the latency actually is

Unchanged by this work: crawl is ~18s of a ~30s turn. But it is **not** the page
count. The lever is per-page crawl cost — sidecar concurrency, `chunkSize`, the
`domcontentloaded` budget, and the tail of slow domains. That is a different
spec, and it should open with the direct manipulation this one skipped.

## Risks

**Snippet quality varies by source.** SearXNG snippets are engine-supplied and
can be a stray sentence; Tavily and Brave snippets are generally cleaner. A
weak snippet on an answer-bearing page would get it dropped pre-crawl. This is
precisely what Phase 1 measures — and if it is common, the kill criterion fires.

**The gate adds a serial 1.7s.** Unlike the fan-out, this cannot overlap the
crawl, because its whole purpose is to decide the crawl's input. On turns that
would have crawled only 15 pages anyway it is a net loss of ~1.7s. If Phase 1
shows small pools are common, a floor (skip the gate when
`candidates <= TOP_N`, since there is nothing to cut) removes that loss
entirely, and it costs one conditional.

**Reranker becomes load-bearing on two stages.** A reranker outage already
degrades to the bi-encoder for the final rank; it would now also disable the
gate. Both fail open independently, so the failure mode is "today's behavior",
not an outage.

## Out of scope

- Conditional Tavily/Brave (rejected above, with measurements)
- Changing `SEARXNG_CRAWL_MULTIPLIER` or `MAX_ENRICH_URLS` — the cap this
  design adds is relevance-ordered, and changing the blunt caps at the same
  time would confound the A/B
- Crawl4AI chunk sizing and sidecar concurrency. The superlinear curve above
  suggests headroom there, but it is an independent lever and deserves its own
  measurement rather than being bundled into this one
- Conditional thinking keyed on `intent`/`skipSearch` — separate, still the
  largest remaining TTFT lever, tracked in
  `2026-07-24-latency-optimization-design.md`
