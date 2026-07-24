# Classifier Output Token-Trim (Latency Phase A.3) — Design

**Date:** 2026-07-24
**Status:** Draft for operator review. Ships ONLY if the quality gate passes.
**Parent:** `2026-07-24-latency-optimization-design.md`; follows the classifier
investigation (granite is generation-bound at ~25 tok/s) and the keep-warm fix.

## Motivation

The classifier runs on granite (local, P5000). granite's latency is dominated
by **how many tokens it generates** (~25 tok/s warm at P0; the keep-warm keeps
it at P0). Its output is `{ skipSearch, standaloneQuery, needsRecent, intent }`
— three tiny fields plus **`standaloneQuery`, a full rewrite of the user's
message**, which is the token hog. On the _majority_ of turns the message is
already self-contained, so the classifier re-emits a query nearly identical to
the input for nothing (~15–30 wasted output tokens → ~0.5–1s at 25 tok/s).

(On cloud this was moot — network-bound. On local granite it's real, which is
why it's worth doing now that we're keeping granite.)

## The change — self-contained to `lib/agents/query-classifier.ts`

Add a `queryIsStandalone` flag to the **LLM output schema** and prompt, and
normalize before returning so the **external contract is unchanged**:

1. `classifierSchema` (the Zod schema the LLM fills) gains
   `queryIsStandalone: z.boolean()`. The public `QueryClassification` interface
   is UNCHANGED (still `{ skipSearch, standaloneQuery, needsRecent, intent }`).
2. Prompt: instruct the model — "Set `queryIsStandalone: true` when the latest
   message is ALREADY a self-contained search query needing no rewrite (a new,
   fully-specified question); in that case output `standaloneQuery: ""`. Set it
   `false` only when the message depends on prior context (pronouns, ellipsis)
   and needs rewriting into a standalone query, which you then put in
   `standaloneQuery`." This is the same judgment the classifier already makes
   implicitly when it chooses whether to rewrite.
3. Normalize before returning (`classifyQuery`, using the already-available
   `latestMessage`): the returned `standaloneQuery` becomes
   `result.queryIsStandalone ? latestMessage : (result.standaloneQuery || latestMessage)`.
   `queryIsStandalone` is internal — not part of `QueryClassification`.

**Blast radius: one file.** Every downstream consumer of
`classification.standaloneQuery` (recall, search, expander, memory extractor,
and A.2's `chooseRecall` — which compares `standaloneQuery === latestMessageText`)
sees the identical resolved value it sees today. `chooseRecall` naturally still
returns `speculative` on standalone turns (because the normalized
`standaloneQuery` equals the raw message). No other file changes.

## Quality gate (SHIP ONLY IF THIS PASSES)

This changes the carefully-tuned classifier prompt/schema, so it does NOT ship
on assertion — it ships on evidence. Build a small eval and run OLD vs NEW
against a representative set of turns (reuse the transcript cases the current
prompt was validated on — see the comment at `query-classifier.ts:97` — plus a
handful of standalone questions, contextual follow-ups, greetings, and
image-gen requests):

- **Decision parity (must hold):** `skipSearch`, `needsRecent`, `intent`
  identical between OLD and NEW on every case.
- **Query parity (must hold):** the NEW resolved `standaloneQuery`
  (post-normalization) equals the OLD `standaloneQuery` on every case — i.e.
  `queryIsStandalone` is judged correctly (true exactly when the OLD output
  equalled the raw message).
- **The win (should hold):** NEW output `eval_count` (tokens) is lower on
  already-standalone turns.

If decision or query parity breaks on any case, DO NOT ship — the flag is
misjudged and the prompt needs more work (or we abandon the trim). The eval
runs classifier calls against **granite (local LLM, not web searches)** — a
bounded ~15–25 calls, not a loop, and never a search.

## Honest cost/benefit

- **Benefit:** ~0.5–1s off classify on already-standalone turns (the majority),
  which is every-turn latency.
- **Cost:** on _rewrite_ turns the output is a few tokens LARGER (the flag +
  the full query). Net positive because standalone turns dominate.
- **Risk:** contained (one file, external contract preserved) and gated (the
  eval). Worst realistic case is we build the eval, it shows drift, and we don't
  ship — no production risk.

## Testing

- Unit: the normalization logic (`queryIsStandalone true → standaloneQuery =
latestMessage`; `false → the rewrite`; empty rewrite → latestMessage) as a
  pure helper, mocked classifier output.
- The eval above is the quality gate (a script under `scripts/eval/`, matching
  the repo's existing eval-results convention).
- Staging: read warm `classify_ms` from organic `[latency]` logs (probe-free)
  and compare standalone-turn classify before/after. NEVER a test search.

## Out of scope

- Query-expander / memory-extractor token trims (same idea could apply, but the
  extractor is async and the expander is a separate change).
- Any change to the classifier's decision rules (skipSearch/needsRecent/intent
  semantics) — this is purely an output-encoding change.
