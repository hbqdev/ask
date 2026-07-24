# Recall Gating + Overlap (Latency Phase A.2) — Design

**Date:** 2026-07-24
**Status:** Draft for operator review. Follows the Phase A measurement.
**Parent spec:** `2026-07-24-latency-optimization-design.md` (Phase A item 2).

## Motivation (from real Phase A data)

The first `[latency]` line, a trivial `skipSearch` turn ("17×3"):

```
prepare_ms:0  classify_ms:4387  recall_ms:4306  ttft_ms:10058  total_ms:12500  skipSearch:true
```

**Recall ran for a math question** — a full embed → pgvector hybrid search →
cross-encoder rerank (~4.3s cold) whose entire purpose is surfacing relevant
_past conversations_, which "17×3" has none of. And it ran **serially after**
the 4.4s classifier, stacking to ~8.7s before the researcher started. (These
are COLD numbers — first turn post-deploy; warm will be lower. But skipping
unnecessary work is right regardless of magnitude.)

## How recall works (grounded in code)

`getRecallInjection(userId, query, chatId)` (called unconditionally at
`create-chat-stream-response.ts` ~L334, after classification resolves):

1. Embed `query` — local, cheap.
2. pgvector hybrid (vector ∪ keyword) search over `conversation_chunks`.
3. **Cross-encoder rerank** on the live reranker (`.17`), capped at
   `RECALL_RERANK_POOL` (default 20) — the **dominant cost** (network hop +
   reranking ~20 candidates; the code comment notes ~7.6s uncapped).

`query` is `classification.standaloneQuery || latestMessageText`.

## Two changes

### 1. Gate recall on `skipSearch` (the primary win)

When `classification.skipSearch` is true, the turn gets **no recall block and no
chips, and the user never waits for recall** (`recall_ms → 0`).

Implementation note (accuracy): because recall is started _speculatively_ before
`skipSearch` is known (change 2), a background recall — including the reranker
hop — still runs and is discarded on a gated turn. So this gates the user-facing
_latency_, not the reranker _load_. Reranker load on gated turns is unchanged
from before (the old code also ran recall on those turns); we've removed the
wait, not the work. Eliminating the work too would require cancelling the
in-flight recall on `skipSearch` (an `abortSignal` through `getRecallInjection`)
— out of scope here.

**Why it's correct, not a quality regression:** the classifier sets
`skipSearch=true` in exactly three cases (per its own prompt rules): casual
small talk; confirming/restating/comparing something the assistant **already
stated in THIS chat**; or an image-generation request. In all three the answer
comes from the current chat's own context, so cross-chat recall cannot add
anything. A question that references a _past_ chat's subject is
`skipSearch=false` by the classifier's rules ("names a subject/fact not yet
stated above → ALWAYS skipSearch=false"), so it still gets recall. The gate
inherits the classifier's conservatism (it defaults to `skipSearch=false` when
uncertain). Net: recall keeps firing on every turn that could benefit, and
stops firing on the trivial turns that measurably waste ~4s.

### 2. Overlap recall with classification (for `skipSearch=false` turns)

Today recall waits for the classifier, then runs — serial. Overlap it:

- Kick off a **speculative recall** on the raw `latestMessageText` in parallel
  with the classifier (before the classifier resolves).
- When the classifier resolves:
  - if `skipSearch` → discard the speculative recall (change 1 wins).
  - else if `standaloneQuery === latestMessageText` (the common case for
    already-standalone questions) → **use the speculative result** — recall's
    ~4s fully overlapped the classifier's ~4s.
  - else (`standaloneQuery` differs — pronoun/context resolution) → discard and
    run recall on `standaloneQuery` (current behavior; no regression).

Worst case = today's latency; best case = recall cost hidden entirely behind
the classifier. The only downside is a wasted speculative rerank when
`standaloneQuery` differs — bounded to one, on the reranker that's local to the
fleet.

## Mechanics

- `create-chat-stream-response.ts`: replace the unconditional
  `const recall = await getRecallInjection(...)` with:
  - a speculative `recallPromise = getRecallInjection(userId, latestMessageText, chatId)`
    started alongside `classificationPromise` (before the stream), and
  - after `classification` resolves: `skipSearch` → `recall = EMPTY`; else
    `standaloneQuery === latestMessageText` → `recall = await recallPromise`;
    else → `recall = await getRecallInjection(userId, standaloneQuery, chatId)`.
- The `latency.mark('recall_ms', …)` boundary moves to wrap whichever path
  actually resolved recall (0 when gated).
- No change to `getRecallInjection` itself, the recall chips, or the researcher
  prompt injection. `recall.hits` / `recall.block` contracts unchanged.
- `EMPTY` = the same shape `getRecallInjection` returns for no hits (`{ hits: [], block: '' }` — confirm exact shape during implementation).

## Recall lookback is maximal and UNCHANGED by this work

Recall (`recall-search.ts`) searches the user's ENTIRE history — pgvector
similarity ∪ keyword over all `conversation_chunks` across all chats (only the
current chat is excluded), with NO recency/date gate. Relevance ranking is the
cross-encoder, not recency, so a match from any point in the past can surface.
This depth is latency-independent of history size: the vector search is
HNSW-indexed (~constant time) and the rerank is capped at a FIXED candidate
pool (`RECALL_RERANK_POOL`, default 20; measured 15→~1s, 30→3.4s, 60→7.6s).
So "as far back as possible without adding latency" is already the design —
the pool cap, not the historical depth, is the latency knob.

**Neither change here reduces that.** Gating only skips recall on turns that
structurally can't use it; overlap changes _when_ recall runs, not _how deep_.
When recall runs, it still searches all of history. (Deepening recall further
would mean raising `RECALL_RERANK_POOL`, which trades latency for breadth —
explicitly out of scope for a latency-reduction phase.)

## Testing

- Unit (extract the decision into a pure helper
  `chooseRecall({ skipSearch, standaloneQuery, latestMessageText })` →
  `'gated' | 'speculative' | 'refetch'`): gated when skipSearch; speculative
  when query unchanged; refetch when standaloneQuery differs.
- The stream wiring keeps its no-new-unit-test posture (whole-suite +
  typecheck), like Phase A Task 3.
- Staging: verify via `[latency]` logs (probe-free) — a `skipSearch` turn shows
  `recall_ms` absent/0; a standalone research turn shows `recall_ms` overlapped
  (total TTFT down vs the Phase A baseline). NEVER a test search — read from
  organic traffic + one `skipSearch` turn.

## Out of scope / next

- **Classifier latency** (`classify_ms` ~4.4s cold) — separate lever; not
  recall. Note for a later phase.
- **Warm baseline:** grab a few warm `[latency]` lines from prod organic
  traffic (now that Phase A is live) to size the real win before/after — but
  the gate is worth shipping regardless (it removes strictly-wasted work).
- Phase B (conditional thinking) still stacks on top of this.
