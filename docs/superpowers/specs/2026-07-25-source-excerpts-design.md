# Source Excerpts — Design

**Status:** proposed
**Date:** 2026-07-25

## Problem

A research turn sends the answering model ~82,000 prompt tokens. The same
conversation without search sends ~6,000. Roughly 93% of a research prompt is
crawled page text.

Measured on staging, `kimi-k2.6:cloud`, one four-turn conversation:

| turn | searched | prompt tokens | total  |
| ---- | -------- | ------------- | ------ |
| 1    | yes      | 82,240        | 75.3 s |
| 2    | no       | 9,875         | 33.5 s |
| 3    | yes      | 55,953        | 91.6 s |
| 4    | no       | 5,958         | 13.0 s |

With 15 returned sources that is ~4,800 tokens — roughly 19,000 characters —
per source. We send entire web pages.

The cost is visible in the stream timeline. Between the search tool returning
and the first prose token:

| turn | search → first prose |
| ---- | -------------------- |
| 1    | 6.6 s                |
| 2    | 13.7 s               |
| 4    | 9.1 s                |

That interval is dead time: the search is finished, nothing is on screen, and
the model is ingesting the prompt.

No comparable system does this. Perplexity assembles "ranked document
excerpts" after a three-layer rerank. Vane (`baseSearch.ts:57`) embeds the
SearXNG snippet and only scrapes in quality mode, where an LLM picker selects
three pages. Upstream Morphic returns Tavily snippets. We are the only one
attaching full page text to every source.

## Key insight

**The excerpts already exist and are discarded.**

`lib/embeddings/rerank.ts` splits every document into 256-token passages with
32-token overlap, scores each passage against the query, and returns:

```ts
export type RerankedDoc<T> = {
  doc: T
  score: number
  topPassages: string[] // top 3 passages, best first
}
```

`app/api/advanced-search/route.ts:867` then does:

```ts
generalResults = reranked
  .filter(r => r.score >= minScore)
  .map(r => r.doc.original)
```

`topPassages` is dropped on the floor. Outside of two assertions in
`lib/embeddings/__tests__/`, nothing in the codebase reads it.

So this is not a new retrieval stage. It is using the output of a stage we
already pay for.

## Design

Build each returned source's `content` from its `topPassages` instead of the
full page.

```
crawl → isQualityContent → rerank (splits into passages, scores, keeps top 3)
      → content = topPassages.join(separator)     ← the change
      → top N sources returned
```

### Interface change

`applyReranked` in `app/api/advanced-search/route.ts` currently discards
everything but `doc.original`. It gains access to `topPassages` and produces a
result whose `content` is the joined passages, leaving `title` and `url`
untouched.

The route's return shape at `route.ts:953` is unchanged — still
`{ title, url, content }`. Nothing downstream learns a new field.

The joining itself lives in a pure helper, `lib/search/build-excerpt.ts`, not
inline in the route:

```ts
buildExcerptContent(
  passages: Array<{ text: string; index: number }>,
  fallback: string
): string
```

The route is a 400-line handler that needs a live SearXNG, a crawler, and a
reranker to exercise. Gap detection, ordering, and the empty case are exactly
the logic most likely to be subtly wrong, and a pure function makes them
testable without any of that.

`fallback` is returned when `passages` is empty — a document that produced no
passages (no content, or a non-passage-scoring tier) keeps its original text.

### Passage ordering — a bug to fix first

`rerank.ts:77-81` currently does:

```ts
passageScores.sort((a, b) => b.score - a.score)
return { ..., topPassages: passageScores.slice(0, 3).map(p => p.passage) }
```

`topPassages` therefore comes back in **descending score order, not document
order**. Nothing noticed because nothing consumed it. Concatenating those
three passages would hand the model a page's paragraphs shuffled — passage 9
before passage 2 — which is worse than useless for anything with a narrative
or procedural structure, and actively misleading with an elision marker
between them.

`rerankByPassageScorer` must track each passage's index, select the top N **by
score**, then restore **document order** before returning. Selection stays
score-based; presentation becomes positional.

This also makes `score` (currently `passageScores[0].score`, the best passage)
independent of ordering — it must keep meaning "best passage score" after the
re-sort, or ranking silently changes and the returned-URL invariant below
breaks.

### Passage joining

With passages in document order, the join is gap-aware. Consecutive passages
(adjacent indices) are contiguous text and are joined with a newline.
Non-consecutive passages have real elided content between them and get an
explicit marker:

```
passage 2 text
passage 3 text
[…]
passage 9 text
```

Writing `[…]` between every pair regardless would assert an elision that does
not exist between adjacent passages.

Note passages carry `PASSAGE_OVERLAP_TOKENS = 32` of overlap, so joining two
adjacent passages duplicates up to 32 tokens. That is bounded, harmless, and
cheaper to accept than a de-duplication pass.

### Count

`PASSAGES_PER_SOURCE` — how many ranked passages to keep, default 3. The
hardcoded `slice(0, 3)` in `rerank.ts` becomes this value, with
`MAX_PASSAGES_PER_DOC = 12` as the ceiling.

Projected prompt: 15 sources x 3 x 256 tokens ~= 11.5k, plus ~6k of
conversation base, versus 82k today — roughly a 5x reduction with **all 15
sources retained**.

### Degradation

`topPassages` only exists when a passage-scoring tier ran. `rerankTier` can
also be `keyword` or `none` (reranker outage, or fewer candidates than the
threshold). When there are no passages for a document, its full content is
used, exactly as today. A reranker outage must not also become a content
regression.

### Rollout control

`SEARCH_EXCERPTS_ENABLED` (default off on first deploy) so the A/B below runs
against the same build, and so a quality problem is one env var away from
reverting rather than a rebuild.

## What this does not change

- **Source count.** All 15 sources are still returned. The stated constraint
  is that the pool must not shrink; this reduces bytes per source, not
  sources.
- **Crawling.** Every candidate is still crawled. Passages can only be
  selected from text we fetched.
- **Citations.** The model cites `toolCallId`s (`lib/agents/researcher.ts:46`),
  not content offsets. The results array keeps its order, length, and URLs.
- **The UI.** `components/search-results.tsx:62` renders `result.content`
  under `line-clamp-2` — two lines. It already shows a fraction of what we
  send; an excerpt is if anything a better two-line preview than the top of a
  page's boilerplate.

## Risks

**Answer quality is the real risk, and it will not show up in a latency
graph.** Three passages of 256 tokens is 768 tokens of a page. A question
whose answer is spread across a page — a comparison table, a spec sheet, a
multi-step procedure — may be answerable from the full text and not from three
excerpts.

Specific failure modes to check for:

1. **Citation without support.** The model cites source [4] for a claim whose
   supporting sentence was in a passage we did not send. The citation still
   renders; the claim is now unsupported. This is the most dangerous outcome
   because it is invisible.
2. **Table and list fragmentation.** Passage splitting is token-based. A
   256-token window through a specification table yields rows without headers.
3. **Lost lede.** The top-scoring passage is the most query-similar, which is
   not always the one carrying the page's actual conclusion.

## Verification

Counts are not a quality signal — that error was made earlier in this work and
corrected. The A/B compares content.

**Method.** Same build, same conversation, same questions, toggling
`SEARCH_EXCERPTS_ENABLED`. Because run-to-run variance is roughly 2x (the same
question measured 117 s and 60 s on consecutive runs), latency needs repeated
runs; quality needs deterministic comparison.

**Latency — repeated, n >= 4 per arm:**

- `prompt_tokens` from the `[latency]` line (expect a large, unambiguous drop)
- `stream["text-start"] - stream["finish-step"]` — the search-to-first-prose
  interval this change targets
- `total_ms`

**Quality — deterministic, per turn:**

- The returned URL list must be identical between arms. Excerpting happens
  after ranking, so any change in which sources are returned means the change
  leaked into selection and is a bug.
- For every citation in the answer, confirm the cited claim is supported by
  text actually sent in that source's passages. This is the check that catches
  failure mode 1, and it has to be done by reading, not counted.
- Ask at least one question whose answer requires a table or a multi-step
  procedure, to probe failure mode 2.

**Stop condition.** If citations lose support, raise `PASSAGES_PER_SOURCE`
before abandoning the approach — the passages are ranked, so more of them is a
dial, not a redesign.

## Scope

- `lib/embeddings/rerank.ts` — track passage indices, restore document order,
  make the kept-count configurable.
- `lib/search/build-excerpt.ts` (new) — pure gap-aware joiner.
- `app/api/advanced-search/route.ts` — `applyReranked` builds content from
  passages behind the flag.

No schema, prompt, or UI changes. Both rerank tiers
(`rerankByCrossEncoder`, the embedding reranker) share
`rerankByPassageScorer`, so the ordering fix lands in one place.

## Not in scope

- **Rerank-before-crawl.** Discussed and deferred. Reranking snippets to pick
  which pages to crawl is less accurate than reranking full text, and it is a
  separate change with its own A/B. This spec keeps ranking quality identical
  by leaving crawl and ranking untouched.
- **The classifier's 8-15.6 s.** The most consistent overhead measured, and
  the next thing worth attacking, but unrelated to prompt size.
