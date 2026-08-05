# Deep-research A/B harness

Does the **new multi-agent** deep-research mode (planner → parallel sub-agents →
synthesize, in `lib/agents/deep-research/`) produce genuinely _deeper_ answers
than the **current single-agent** deep-research mode (≥15 searches + a todo list
+ one report)? This harness measures that, head to head, on a curated set of
research-worthy questions.

Lab tool. It does not touch staging/prod and it does not know how to invoke
either mode — that seam is injected (see [Wiring](#wiring-invokedeepresearch)).

## What it measures

For each question it runs **both** modes, then a blind LLM judge scores each
answer on four 1–5 dimensions and picks a winner:

| dimension          | question the judge is asked                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| **depth**          | Beyond a surface summary — mechanisms, trade-offs, second-order effects, nuance?                    |
| **coverage**       | The full breadth of the question — every sub-part and the important competing angles?              |
| **specificity**    | Concrete — named entities, numbers, dates, quantified trade-offs — not vague generalities?          |
| **citationQuality**| Sources relevant/credible/varied, and do the claims actually appear grounded in them?              |

The judge also returns a one-paragraph rationale and a winner (`A`/`B`/`tie`),
which is de-randomized to `single`/`multi`/`tie` before recording.

Reported: **multi-vs-single win rate**, **average per-dimension scores** for each
mode, and one **JSONL line per question** written to `../results/`.

## Files

- `questions.ts` — the curated question set (typed, each with a note on _why_ it
  is deep-research-worthy). Comparisons, evidence-synthesis, and "map the
  landscape" questions across varied domains — the shape where multi-agent depth
  can actually show up.
- `judge.ts` — the blind, position-bias-controlled LLM judge. Follows the
  `generateText` / `Output.object({ schema })` pattern from
  `lib/agents/query-expander.ts` and resolves the judge model via `getModel`
  from `lib/utils/registry.ts`. Exports the pure de-randomization helpers.
- `aggregate.ts` — pure win-rate + per-dimension score aggregation.
- `run-ab.ts` — the runner: injects `invokeDeepResearch`, runs both modes per
  question, judges, records JSONL, prints the summary table.
- `types.ts` — shared types (the injection contract, verdicts, records).
- `__tests__/deep-research-ab.test.ts` — unit tests for the pure logic
  (aggregation, A/B de-randomization mapping, fallback JSON parsing).

## Wiring `invokeDeepResearch`

The runner is parameterized by one function you implement in
`run-ab.ts` (currently a stub that throws):

```ts
type InvokeDeepResearch = (
  question: string,
  mode: 'single' | 'multi'
) => Promise<{ answer: string; sources: { title: string; url: string }[] }>
```

- `mode: 'single'` → run Ask's **current** single-agent deep research and return
  its final report text + the sources it cited.
- `mode: 'multi'` → run the **new** orchestrator
  (`lib/agents/deep-research/orchestrator.ts` `runDeepResearch(...)`) and its
  synthesis step, returning the final cited answer + sources.

Keep both arms on the **same** answering model and the same `sources`, so the
only variable is single-vs-multi. Return an empty `answer` (do **not** throw) for
a normal empty research run — the runner records that; throw only when a mode
cannot run at all (which is caught and recorded as an error, excluded from
aggregates).

## Running (once wired)

```bash
bun run scripts/eval/deep-research-ab/run-ab.ts            # all questions
bun run scripts/eval/deep-research-ab/run-ab.ts --limit 3  # first 3
bun run scripts/eval/deep-research-ab/run-ab.ts --out my-run.jsonl

# choose the judge model (default below)
EVAL_JUDGE_MODEL=ollama:glm-5.2:cloud \
  bun run scripts/eval/deep-research-ab/run-ab.ts
```

Unit tests (pure logic only — no live calls):

```bash
bun run test scripts/eval/deep-research-ab
```

## Validity notes

- **Blind, randomly A/B-ordered.** For every question the judge sees the two
  answers as "Answer A" / "Answer B", with the single-vs-multi assignment chosen
  at **random** per question. LLM judges have a documented bias toward whichever
  answer is in position A; randomizing makes that bias average out instead of
  masquerading as signal. The verdict is then **de-randomized** back into mode
  space before anything is recorded, so no downstream step ever sees the position
  labels. (`derandomizeWinner` / `derandomizeScores` are pure and unit-tested.)
- **Strong, independent judge.** Default `EVAL_JUDGE_MODEL` is
  `ollama:qwen3.5:397b:cloud` (same env var and default as
  `scripts/eval/run-eval.ts`). Use a strong judge distinct from the answering
  model — a weak judge can't separate a genuinely deep answer from a fluent
  shallow one, which is the whole point of the test.
- **Substance over length.** The rubric explicitly tells the judge not to reward
  length/formatting/confidence and to count padding _against_ depth and
  specificity — so "multi wrote more" isn't scored as "multi went deeper".
- **Structured output + fallback.** The judge first asks via
  `Output.object({ schema })`; if the model won't honor the schema (a documented
  failure for the self-hosted Ollama models — see `scripts/eval/run-eval.ts`), it
  re-asks for a single raw JSON object validated against the **same** zod schema.
  If neither parses, that question is recorded as an error and excluded from
  aggregates — never guessed.
- **Failures counted, not dropped.** A mode that fails to run makes the question
  `skipped`; a judge failure makes it `errored`. Both are counted in the summary
  but excluded from win-rate and score averages.

## Interpreting the result

A real "multi is deeper" signal looks like a multi win rate well above single
**and** higher average `depth`/`coverage`/`specificity` — not just more sources.
If multi wins on citation count but ties on depth, that is breadth, not depth,
and the rubric is designed to surface that difference.
