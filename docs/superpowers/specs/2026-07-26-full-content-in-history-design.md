# Full Content in History — Design

**Status:** proposed
**Date:** 2026-07-26

## Problem

Two independent attempts to send the model less per source both measured worse
end to end, with the same failure mode.

**Source excerpts** (`SEARCH_EXCERPTS_ENABLED`), two paired A/Bs, identical
prompts:

|             | off    | on     |
| ----------- | ------ | ------ |
| A/B #1 mean | 51.7 s | 55.0 s |
| A/B #2 mean | 42.4 s | 86.0 s |

**Speed mode** (snippets only, never crawls), identical prompts against
balanced:

|      | balanced | speed  |
| ---- | -------- | ------ |
| mean | 42.4 s   | 48.0 s |

In both cases the first turn behaved exactly as designed — speed mode answered
T1 in 25.0 s against balanced's 66.3 s, a 2.6x win — and the **follow-up turn**
destroyed the gain:

| follow-up turn                  | tools | total     |
| ------------------------------- | ----- | --------- |
| balanced (2,512 chars/source)   | **0** | **9.2 s** |
| speed (259 chars/source)        | 3     | 61.1 s    |
| excerpts on (~700 chars/source) | 5     | 107.3 s   |

Balanced answered the follow-up from conversation context. The thin-content
arms searched again.

## Mechanism

A tool result is a single object. The same bytes are

1. sent to the model on the turn that produced it, and
2. replayed to the model as conversation history on later turns.

`pruneMessages` keeps tool results for `before-last-2-messages`
(`create-chat-stream-response.ts:311`), so the immediately-following turn still
sees the previous turn's search results in full.

That is exactly the turn that regressed. When per-source content drops from
~2,500 chars to ~250-700, the follow-up no longer has enough in context to
answer from, so the model searches again — and a fresh search plus crawl plus
rerank costs far more than the bytes ever saved.

**Sending less to the model does not make turns cheaper. It makes LATER turns
expensive.**

Note what is NOT the problem: source counts held (28/26/15/29 with excerpts vs
32/24 without) and grounding held (90-100% traceable claims in every arm).
Selection is on rerank score, which content shaping never touches. This is
context loss across turns, not source loss.

## Design

Decouple the two roles of a tool result:

- **To the model, this turn:** excerpts — the top-ranked passages. Small.
- **To history, later turns:** the full crawled text. Complete.

The search tool already yields its final result once. This spec adds a
full-content variant that is persisted instead of the yielded one, so replayed
history carries the depth that follow-ups need while the live prompt stays
small.

### Where the two representations diverge

`applyReranked` in `app/api/advanced-search/route.ts` builds each returned
source. It currently emits one `content`. It gains a parallel full-text value
so the route can return both shapes; the excerpt stays exactly what
`buildExcerptContent` produces today.

The route's response gains one field alongside `results`:

```ts
{
  results: SearchResultItem[]        // excerpted — what the model reads now
  fullResults?: SearchResultItem[]   // full crawled text — for history
  query, images, number_of_results
}
```

`fullResults` is present only when excerpting actually happened. With
`SEARCH_EXCERPTS_ENABLED` off the two would be identical, so it is omitted and
nothing changes.

### Carrying it to persistence

Both the yield and the persist happen inside one request, so a request-scoped
map is sufficient — no new storage, no cross-request state.

1. `lib/tools/search.ts` yields the excerpted `results` (unchanged), and
   records `fullResults` against the tool call id in a request-scoped map.
2. `onFinish` in `create-chat-stream-response.ts` already cleans the assembled
   `responseMessage` before persisting (`stripNarrationFromMessage`). A new
   step in the same place rehydrates any `tool-search` part whose id is in the
   map, replacing its output `results` with `fullResults`.
3. `persistStreamResults` stores the rehydrated message. Unchanged.

The map is keyed by `toolCallId` and lives for the request. A missing entry
means "nothing to rehydrate" and the part is persisted as-is, so a failure of
this mechanism degrades to today's behaviour rather than losing content.

### What the model sees, turn by turn

|                     | turn N  | turn N+1 (history)           |
| ------------------- | ------- | ---------------------------- |
| today, excerpts off | full    | full                         |
| today, excerpts on  | excerpt | **excerpt** ← the regression |
| after this change   | excerpt | **full**                     |

## Risks

**Prompt size on the following turn.** This deliberately puts full text back
into turn N+1's context — the thing excerpts set out to remove. The saving
becomes "one turn's prompt is small" rather than "all prompts are small".
Measured: search payload 199,606 B -> 45,212 B on the turn that searches. Turn
N+1 pays the old cost. If the follow-up regression is really about context
depth, that is the trade being made deliberately; if turn N+1 then becomes the
slow one, the hypothesis is wrong and this should be reverted rather than
tuned.

**A UI/model divergence.** The persisted message will no longer be byte-identical
to what the model was shown. Citations reference `toolCallId`s and source URLs,
neither of which changes, and the UI clamps `content` to two lines
(`components/search-results.tsx:62`) — but any future code that assumes "what
was persisted is what the model saw" would now be wrong. Worth a comment at the
rehydration site.

**Rehydration silently not firing.** Then behaviour is exactly today's, which
is safe but makes a failed experiment look like a null result. The verification
below checks the persisted bytes directly rather than inferring from latency.

## Verification

**Deterministic, first:**

- Persisted `tool_search_output` for a turn must contain **full** content
  (~2,500 chars/source), while the same turn's `[latency:search]` shows the
  excerpted payload. If persisted content is still ~700 chars/source, the
  rehydration did not fire and every latency number below is meaningless.

**Then the behaviour this exists to fix** — paired A/B, identical prompts, one
chat per arm, at least a first turn and a follow-up:

- **The follow-up turn's `tool_calls` must be 0**, matching balanced-with-full-
  content. That is the single number this whole change targets. Latency follows
  from it.
- Turn totals for both turns, since turn N+1's prompt grows.
- Source counts unchanged (they should be — selection is on rerank score).
- Numeric-claim traceability against the sources actually sent, the check that
  caught the thinking regression (100% -> 62%) and cleared excerpts (98%).

**Sample size.** Run-to-run variance is roughly 2x and every 3-turn comparison
this session has been inside it. The `tool_calls` count on the follow-up is
discrete and far more informative than a mean; prefer it.

## Not in scope

- **Speed mode.** It has the same follow-up regression from the same cause, but
  fixing it means changing what it retrieves, not what it persists. Separate
  decision.
- **Re-enabling `SEARCH_EXCERPTS_ENABLED` by default.** This spec makes
  excerpts viable; whether they ship stays a separate call once measured.

  **Measured 2026-08-01: do not ship.** Per-step prompt size fell only 5% (the
  entire point of the change), while steps rose 142% and turns ran 17% slower,
  and citation-without-support reproduced on two of two probed turns. See the
  "Result" section of `2026-07-25-source-excerpts-design.md`.
