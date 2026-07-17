# Ask eval harness

Nothing else in this repo measures answer **quality**. The 607 tests under
`lib/**/__tests__` check mechanics (parsing, persistence, tool wiring) — none
of them ask "was this a good answer?" This harness exists to replace
guesswork with measurement when comparing configs: model A vs B, tool-call
budgets (via `searchMode`), or any other `(model, searchMode)` pair defined
in `run-eval.ts`'s `CONFIGS` registry.

It is a dev tool, not product code. It drives the real `/api/chat` endpoint
against **staging** (an isolated Docker stack — see `docker-compose.admin-feature.yaml`
— that runs in anonymous-auth mode), reads results back out of Postgres, and
scores them two ways: objective metrics that need no human labels, and a
blind, position-bias-controlled pairwise LLM judge.

## Files

- `questions.json` — the eval question set: `[{ id, text, tags? }]`. Mined
  from real prod chat history (see below). Currently 64 questions
  (`q001`-`q064`).
- `mine-questions.ts` — regenerates `questions.json` from prod chat history.
- `run-eval.ts` — the runner, objective scorers, pairwise judge, and CLI.
- `results/` — raw output of every run, one JSON file per invocation,
  named by timestamp. Committed results are re-analyzable without re-running
  turns (`--judge-only`).

## Quick start

```bash
# (Re)generate the question set from prod chat history
bun run eval:mine

# Compare two configs over the full question set
bun run eval --config-a kimi --config-b minimax

# Same, but capped to 10 questions and 2 turns in flight at once
bun run eval --config-a kimi --config-b minimax --limit 10 --concurrency 2

# Re-judge an existing results file without re-running turns (turns are
# expensive — 30-250s each; judging is cheap)
bun run eval --judge-only scripts/eval/results/2026-07-17T04-57-21-676Z.json
```

Prerequisites: the staging stack must be running (`docker compose -f
docker-compose.yaml -f docker-compose.admin-feature.yaml up -d`, or however
your deployment starts it) and reachable at `$EVAL_API_URL`
(default `http://localhost:3739/api/chat`).

## 1. Question mining (`mine-questions.ts`)

Extracts the **first user message of every chat** from the **prod** database
(`ask-postgres` by default — always prod, real usage, never staging/eval
traffic). The DB is only reachable in-container, so this shells out to
`docker exec <container> psql ...` rather than connecting directly.

- Kept only if the message length is in `[20, 300]` chars (`--min-len` /
  `--max-len` to change).
- Skipped if it contains a URL (`--include-urls` to keep them instead,
  tagged `tags: ["url"]`) — a URL in the first message routes straight to
  the `fetch` tool rather than `search`, a materially different code path
  that a plain question-quality comparison shouldn't silently mix in.
- IDs (`q001`, `q002`, …) are assigned after ordering candidates by the
  underlying chat's `created_at` (oldest first) — via SQL's `ORDER BY`
  inside the aggregate, not JS array order, which `json_agg` alone doesn't
  guarantee. Re-running against an unchanged DB reproduces byte-identical
  output; running it later only appends new ids after the existing ones.

```bash
bun run eval:mine
bun run scripts/eval/mine-questions.ts --container ask-postgres --include-urls
```

Env: `EVAL_MINE_DB_CONTAINER` (default `ask-postgres`), `EVAL_DB_USER` /
`EVAL_DB_NAME` (default `morphic`).

## 2. The runner

For each `(question × config)` pair, `run-eval.ts`:

1. Generates a **fresh `chatId`** and POSTs a `submit-message` turn to
   `$EVAL_API_URL` — no shared history between runs, so nothing from one
   config/question can leak context into another.
2. Selects the model and search mode the same way the browser UI does: a
   `selectedModel` cookie (`lib/config/model-selection-cookie.ts`'s format —
   `providerId:modelId`, URI-encoded) and a `searchMode` cookie
   (`speed` | `balanced` | `quality`, the values `app/api/chat/route.ts`
   reads directly).
3. Drains the SSE response to completion (content isn't parsed — the DB is
   the source of truth — but draining confirms the server-side stream, and
   therefore its `onFinish`/persistence step, actually finished).
4. Polls Postgres (`$EVAL_DB_CONTAINER`, default `ask-postgres-admin-feature`
   — **staging**, not prod) for the assistant message, up to 30s.
5. Extracts: `answerText` (the last `type='text'` part of the assistant
   message), `toolCalls`/`searches`/`fetches` (counts by `tool-*` part type),
   `toolCallIds`, `latencyMs` (`assistant.created_at − user.created_at`,
   both read from the DB — never client-side wall-clock), `answerChars`.
6. Sanity-checks the persisted message's `metadata.modelId` against the
   config's `model` — a mismatch means the cookie didn't take effect and
   this run measured the _wrong_ config, so it's recorded as an `error` and
   excluded from aggregates rather than silently misattributed.

Turns run **sequentially by default** (`--concurrency 1`) with a 1s pause
between dispatches; `--concurrency N` runs N turns in flight (each still
isolated by its own `chatId`). Questions and configs are interleaved as
`[(q1,A), (q1,B), (q2,A), (q2,B), ...]` so an interrupted run still has
paired data for whatever finished, rather than a complete A-pass and an
empty B-pass.

One bad question/turn never kills the run: network and DB failures are
caught, recorded in that run's `error` field, and the loop continues.
Raw results (every run, including failures) are written to
`scripts/eval/results/<timestamp>.json`.

## 3. Objective scorers

Computed per run, then averaged per config over **non-errored runs only**
(errors are reported as a count, never averaged-in or substituted with 0):

| Metric                                        | Meaning                                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `avgToolCalls` / `avgSearches` / `avgFetches` | Mean count of `tool-*` parts on the assistant message, by type. Proxies "tool-call budget" spend for a given `searchMode`. |
| `avgLatencyMs`                                | Mean of `assistant.created_at − user.created_at`, both DB timestamps.                                                      |
| `avgAnswerChars`                              | Mean length of the final answer text.                                                                                      |
| `citedRuns` / `avgCitationValidPct`           | **Citation validity** — see below.                                                                                         |

**Citation validity** catches fabricated citations. The app's citation
format is `[N](#toolCallId)` (`lib/utils/citation.ts`'s
`processCitations`); the research prompts explicitly warn models "NEVER
invent placeholder anchors like `#fetch_prevention`" — this scorer measures
whether that warning holds. For each `[N](#toolCallId)` anchor in the
answer, it checks whether `toolCallId` exists among the tool calls the
assistant message actually made (normalizing a `toolu_`/`call_`/`search-`
prefix the same way `lib/utils/citation.ts`'s `stripToolCallPrefix` does, so
this doesn't flag a citation as invalid when the real app would still
resolve it). `validPct` is `null` (not `0`) when a run has zero citations —
never averaged in as if it were a run that failed every citation, since
that's a different thing than a run that cited nothing.

## 4. Pairwise judge

For each question with a successful run on both sides, an LLM judge picks
which of the two answers is better — this is the core of the harness; the
objective scorers alone can't tell you whether an answer is actually _good_.

- **Judge model**: `$EVAL_JUDGE_MODEL` (default `ollama:qwen3.5:397b:cloud`),
  constructed via the app's own `getModel()`
  (`lib/utils/registry.ts`) and called with `generateText` from `ai`,
  mirroring `lib/agents/query-classifier.ts`'s structured-output pattern
  (`Output.object` + a zod schema). Env is loaded from `.env` — **not**
  `.env.local`, since that's where this deployment's real Ollama/DB config
  lives — with `override: true` so it wins even if the runtime already set
  something first.
- **Criteria**: factual accuracy, grounding in cited sources, directness
  (does it answer what was asked, without padding or drifting to other
  topics), completeness.
- **Blind + de-identified**: the judge is never told which config produced
  which answer (only "Answer A" / "Answer B"). `deidentify()` strips common
  model/vendor self-references (kimi, minimax, deepseek, qwen, claude,
  gpt-\*, gemini, llama, …) before either answer is shown to the judge, so a
  stray "As Kimi, developed by Moonshot AI..." can't give it away. This is
  best-effort, not airtight — a sufficiently determined judge could still
  infer origin from style.
- **Position-bias control**: every pair is judged **twice** — once as
  (A, B), once as (B, A) — and a config only gets credited with a win if
  **both** orders agree after remapping the swapped call back to A/B space.
  Any disagreement (including either call landing on "tie") scores as a
  **tie**. This is not optional: LLM judges have strong, well-documented
  position bias, and without this control the win/loss numbers are noise
  rather than signal.
- **Structured output, with a tested fallback** — see Limitations below.
  The primary attempt is exactly what the task asked for: `Output.object`
  with a `{ winner: 'A'|'B'|'tie', reason: string }` zod schema. When that
  fails (which, on every Ollama-cloud model available in this deployment, it
  reliably does), a second real judge call asks for a plain
  `WINNER: / REASON:` two-line format instead — verified live to parse
  cleanly across every model tried. Verdicts that took this path are marked
  `fallbackParsed: true` in the results file and counted in the printed
  report, so it's always visible how much of the judge's output was true
  schema-constrained generation vs. this fallback.

Aggregated per pair: wins/ties/losses and win rate for each config, judge
error count, and fallback-parse count.

## 5. CLI

```
bun run eval --config-a <name> --config-b <name> [options]
bun run eval --judge-only <resultsFile> [--config-a <name> --config-b <name>]

  --config-a <name>     First config to compare
  --config-b <name>     Second config to compare
  --limit <n>           Cap the number of questions used
  --concurrency <n>     Parallel turns (default: 1)
  --judge-only <file>   Re-judge an existing results file instead of re-running turns
  --questions <path>    Questions file (default: scripts/eval/questions.json)
  --out-dir <path>      Results output directory (default: scripts/eval/results)
  --api-url <url>       Override $EVAL_API_URL
  --judge-model <id>    Override $EVAL_JUDGE_MODEL
```

Named configs live in `CONFIGS` at the top of `run-eval.ts` — add an entry
there to compare something else (a different model, a different
`searchMode`, or both). Current entries: `kimi`, `minimax`,
`balanced-default`, `kimi-speed`, `kimi-quality`.

`--judge-only` re-judges an existing results file **in place** (updates its
`judge` key, leaves `runs` untouched) — turns are the expensive part
(30-250s each); judging a saved file is cheap and safe to re-run, e.g. after
changing `--judge-model` or after a judge bug fix.

Env vars:

| Var                             | Default                          | Meaning                                                  |
| ------------------------------- | -------------------------------- | -------------------------------------------------------- |
| `EVAL_API_URL`                  | `http://localhost:3739/api/chat` | Chat API endpoint (staging)                              |
| `EVAL_DB_CONTAINER`             | `ask-postgres-admin-feature`     | Postgres container to read run results from (staging)    |
| `EVAL_MINE_DB_CONTAINER`        | `ask-postgres`                   | Postgres container `mine-questions.ts` reads from (prod) |
| `EVAL_DB_USER` / `EVAL_DB_NAME` | `morphic`                        | Postgres credentials, both DBs                           |
| `EVAL_JUDGE_MODEL`              | `ollama:qwen3.5:397b:cloud`      | Judge model, `providerId:modelId`                        |

Example — a real kimi-vs-minimax comparison:

```bash
bun run eval --config-a kimi --config-b minimax
```

## Limitations — read before trusting the numbers

- **Staging only.** Runs target the `ask-admin-feature` / `ask-postgres-admin-feature`
  containers (anonymous auth — `ENABLE_AUTH=false`). Prod (`ask` /
  `ask-postgres`) requires real auth and is never written to by this tool;
  question _mining_ reads prod (read-only), everything else runs against
  staging.
- **Judge structured-output fallback.** `Output.object` — the exact pattern
  the task's design and `lib/agents/query-classifier.ts` both use — was
  live-tested during development against every model in this deployment's
  `OLLAMA_MODELS` (`qwen3.5:397b:cloud`, `kimi-k2.6:cloud`, `glm-5.2:cloud`,
  `deepseek-v4-flash:cloud`, `minimax-m3:cloud`), independent of the
  registry's forced `think: true`. **None of them reliably honored the
  requested JSON schema** for this judge prompt: some answered in bare prose
  (`"tie"`, `"**Tie**"`), others wrapped a real verdict in self-invented JSON
  shapes (`better_answer`, `overall_winner`, per-criterion nested `winner`
  keys) that legitimately don't match what was asked for — including one
  case (`qwen3.5:397b:cloud`, the default judge model) that returned
  schema-shaped-but-empty values (`{"winner":"","reason":""}`). This reads
  as an Ollama-cloud-routing / structured-output gap, not a per-model quirk.
  The fallback (a second real call asking for a plain `WINNER:`/`REASON:`
  format) was verified to parse cleanly across all five, so the judge is
  functional on this host — but it means most verdicts from the default
  judge model are `fallbackParsed: true`, not true schema-constrained
  output. If you swap in an `EVAL_JUDGE_MODEL` from a provider with reliable
  native structured outputs (OpenAI/Anthropic/Google), expect the primary
  path to succeed instead and `fallbackParsedCalls` to drop to 0 — check the
  printed report / `judge.verdicts[].forward.fallbackParsed` either way.
- **De-identification is best-effort.** Style, formatting habits, or
  language-specific tics can still leak which config produced an answer to
  a sufficiently attentive judge model, even with identity tokens stripped.
- **Judge errors and skipped questions are excluded, not treated as
  losses.** A question where one config's run errored is skipped from
  judging entirely (see `judge.skipped`); a question where the judge itself
  errored twice (schema _and_ fallback both failed) counts toward
  `judge errors`, not toward either config's win/loss/tie. Both are
  reported in the printed table — always check they're a small fraction of
  the total before trusting a win rate.
- **Small samples move a lot.** With 64 mined questions (fewer once URL
  ones are excluded and any question a run fails on), a handful of
  judge/network errors can visibly shift a win rate. Look at the
  `runs`/`errors`/`questions judged` counts alongside any percentage.
- **This harness measures what happened in this environment, on this
  Ollama-cloud host, on the day it ran** — it is not a claim about the
  underlying models' capability in general.
