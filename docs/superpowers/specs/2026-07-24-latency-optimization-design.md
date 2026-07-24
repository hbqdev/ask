# Ask Latency Optimization — Design

**Date:** 2026-07-24
**Status:** Draft for operator review (brainstorm approved: measure-first + pure
wins + conditional thinking + leaner search, "best of both worlds, no quality
loss"). Written autonomously overnight from a read of the live pipeline.

## Goal

Cut prompt→answer latency without degrading answer quality. Attack all three
felt pains (time-to-first-token, research-turn length, follow-up sluggishness)
via measurement, parallelization, and two operator-approved behavioral levers
(conditional thinking, leaner search) that only ever _save_ work on turns that
don't need it.

## Where the time goes (mapped from code)

Pre-stream / per-turn chain in `lib/streaming/create-chat-stream-response.ts`:

- Classifier is **already parallelized** — `classificationPromise` starts at
  ~L161 before the stream and is awaited at ~L320. Good; not a serial cost.
- Recall (`getRecallInjection`, ~L325) runs **after** the classification await
  because it uses `classification.standaloneQuery`.
- Query expansion (~L352) starts after classification and is awaited by the
  first search.
- The researcher (Ollama, cloud) then runs with `providerOptions.think` — and
  **`think: true` is hardcoded for every Ollama turn** (`model-selection.ts:33`
  `buildProviderOptions`, `default-model.ts:20`), applied at
  `researcher.ts:521`. kimi/granite reason before emitting ANY token, so even a
  trivial follow-up pays full thinking latency to first token.

Support models: classifier granite4.1:8b @16k ctx, 10s timeout, 20-msg window
(`query-classifier.ts`).

## Phases

### Phase A — Measure + pure wins (zero behavior change)

1. **Per-stage timing.** Emit one structured line per turn
   (`[latency] { chatId, classify_ms, recall_ms, expand_ms, search_ms,
crawl_ms, rerank_ms, ttft_ms, total_ms, mode, skipSearch }`) from
   `create-chat-stream-response.ts`. This is the load-bearing deliverable —
   every later decision keys off real numbers, not guesses. Additive only.
2. **Overlap recall with classification where safe.** Recall needs
   `standaloneQuery`; kick off an embedding of the raw latest message
   speculatively in parallel with the classifier, and only re-embed if the
   classifier's `standaloneQuery` differs materially. Saves the recall
   embedding round-trip on the common path.
3. **Trim dead awaits.** Audit the chain for any `await` that blocks the stream
   without feeding first-token content; move below the stream start.

Success: numbers visible in logs; no output change (verify identical answers on
a fixed query set staging vs prod).

### Phase B — Conditional thinking (operator-approved; biggest TTFT lever)

Gate `think` on turn difficulty instead of always-on:

- **Quality mode:** always `think: true` (unchanged).
- **Speed mode:** `think: false`.
- **Balanced mode:** `think: true` only when the turn does real work —
  `!classification.skipSearch` (a research turn) OR the classifier flags the
  question as complex. Trivial follow-ups (`skipSearch`, short) answer with
  `think: false` → near-instant first token.

Mechanism: thread the (already-computed) classification decision into the
researcher's `providerOptions` at `researcher.ts:521` rather than baking
`think` into the static model config. No new model calls — reuses the
classifier we already run. Quality is preserved because every turn that could
benefit from reasoning still gets it; only turns the classifier already judged
trivial lose it.

Success: TTFT on a trivial follow-up drops from full-thinking latency to
~prompt-eval time; research/complex turns unchanged.

### Phase C — Leaner search (operator-approved; research-turn latency)

- **Snippet-first crawl:** rerank the candidate pool on titles+snippets first,
  then Crawl4AI-fetch only the top-K (e.g. 5) that will actually be read,
  instead of crawling the whole merged pool. Cuts the slowest stage (page
  fetches) on most turns.
- **Answer-from-snippets fast path:** if crawl is slow/insufficient, proceed
  with snippet text rather than blocking on page bodies.
- **Result cache (Ask's Redis):** cache the merged candidate pool per
  normalized query for a short TTL (~1 day) so repeated/similar queries skip
  the engine fan-out entirely. (This is the "redis caches results" lever that
  SearXNG's valkey does NOT provide — it lives here.) Also directly reduces
  pressure on the (already fragile) upstream engines.

Success: median research-turn wall-clock down materially; obscure-topic quality
unchanged (top-K crawl still reads the best sources; K tunable).

## Non-goals / guardrails

- No change to answering-model choice or reranker model (quality anchors).
- Every behavioral lever only _removes_ work on turns the classifier already
  judged trivial, or _reorders_ work — never reduces reasoning/sources on turns
  that need them.
- Ship phase-by-phase; Phase A's numbers gate whether B/C are worth their
  complexity and confirm no regression.

## Testing

- Phase A: unit-test the timing emitter shape; diff answers on a fixed query
  set (staging vs prod) to prove zero output change.
- Phase B: unit-test the think-decision matrix (mode × skipSearch × complexity);
  staging A/B on a trivial follow-up (TTFT) and a research turn (unchanged).
- Phase C: unit-test snippet-first top-K selection and the cache key/TTL;
  staging check that obscure queries still surface deep sources.
