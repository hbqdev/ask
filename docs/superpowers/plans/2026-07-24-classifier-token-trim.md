# Classifier Token-Trim (Phase A.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the classifier's output tokens (its main latency driver on granite) by emitting a `queryIsStandalone` flag instead of re-typing the full `standaloneQuery` on already-standalone turns — shipping ONLY if a quality eval proves the decisions and resolved query are unchanged.

**Architecture:** The change is contained to `lib/agents/query-classifier.ts`: the LLM schema/prompt gains `queryIsStandalone`; the classifier normalizes `standaloneQuery = latestMessage` when the flag is true, so the public `QueryClassification` contract is byte-identical and nothing downstream changes. A deterministic (temperature-0) eval captures the OLD classifier's outputs, then re-runs the NEW classifier and asserts parity.

**Tech Stack:** TypeScript, Zod, Vercel AI SDK (`generateText`/`Output`), Ollama (granite on `.171`), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-24-classifier-token-trim-design.md`.

## Global Constraints

- NEVER add `Co-Authored-By` or any AI-attribution trailer to commits.
- Format single files with `bunx prettier --write <file>` — never `bun run format`.
- Tests: `bun run test` (Vitest), never `bun test`.
- **Public contract unchanged:** `QueryClassification` stays `{ skipSearch, standaloneQuery, needsRecent, intent }`. `queryIsStandalone` is internal to the LLM output only. No downstream file (recall, search, expander, extractor, `chooseRecall`) changes.
- **Quality gate is binding:** ship ONLY if decision parity (skipSearch/needsRecent/intent) AND query parity (resolved standaloneQuery) hold on every eval case vs the OLD baseline. If either drifts, DO NOT ship — report and stop.
- The eval fires classifier calls against **granite (local LLM), never web searches**. Bounded (~15–25 cases × 2 runs), deterministic (temperature 0).
- The classifier prompt is hand-tuned (`query-classifier.ts:93-99`) — preserve all existing decision rules verbatim; only ADD the queryIsStandalone instruction.

---

### Task 1: Eval harness + representative cases + OLD baseline

**Files:**

- Create: `scripts/eval/classifier-cases.ts` (the case set)
- Create: `scripts/eval/classifier-eval.ts` (runner)
- Create: `scripts/eval/classifier-baseline.json` (captured OLD outputs — committed)

**Interfaces:**

- Produces:
  - `classifier-cases.ts` exports `CASES: { name: string; messages: UIMessage[] }[]` — representative turns (see below).
  - `classifier-eval.ts`: `bun run scripts/eval/classifier-eval.ts --capture` runs `classifyQuery` on each case and writes `{ [name]: { skipSearch, standaloneQuery, needsRecent, intent } }` to `classifier-baseline.json`. `bun run scripts/eval/classifier-eval.ts --check` runs the current classifier and diffs against the baseline, printing per-case PASS/FAIL for decision parity + query parity, and exits non-zero on any mismatch.

- [ ] **Step 1: Write the case set.** Create `scripts/eval/classifier-cases.ts`. Build `UIMessage[]` conversations (a `messages` array with `{ id, role, parts: [{ type: 'text', text }] }`) covering every classifier rule:

```ts
import type { UIMessage } from 'ai'

const u = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage
const a = (id: string, text: string): UIMessage =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text }] }) as UIMessage

export const CASES: { name: string; messages: UIMessage[] }[] = [
  // Standalone factual questions → queryIsStandalone should be true.
  {
    name: 'standalone-vectordb',
    messages: [u('1', 'what is the best open source vector database in 2026')]
  },
  {
    name: 'standalone-photosynthesis',
    messages: [u('1', 'how does photosynthesis work')]
  },
  {
    name: 'standalone-news',
    messages: [u('1', 'latest news about openai this week')]
  },
  // Contextual follow-ups → queryIsStandalone false, needs rewrite.
  {
    name: 'followup-pricing',
    messages: [
      u('1', 'tell me about the Pinecone vector database'),
      a('2', 'Pinecone is a managed vector database...'),
      u('3', 'what about its pricing?')
    ]
  },
  {
    name: 'followup-pronoun',
    messages: [
      u('1', 'who is the CEO of Anthropic'),
      a('2', 'Dario Amodei is the CEO of Anthropic.'),
      u('3', 'where did he go to school?')
    ]
  },
  // New-entity follow-up → skipSearch false (names a new subject).
  {
    name: 'new-entity',
    messages: [
      u('1', 'tell me about Python'),
      a('2', 'Python is a programming language...'),
      u('3', 'what about Rust?')
    ]
  },
  // Pure confirmation of THIS chat's content → skipSearch true.
  {
    name: 'confirm-restate',
    messages: [
      u('1', 'what is the capital of France'),
      a('2', 'The capital of France is Paris.'),
      u('3', 'so the capital is Paris, right?')
    ]
  },
  // Casual small talk → skipSearch true.
  { name: 'greeting', messages: [u('1', 'hey there!')] },
  {
    name: 'thanks',
    messages: [
      u('1', 'what is 2+2'),
      a('2', '2 + 2 = 4.'),
      u('3', 'thanks, that helps')
    ]
  },
  // Image generation → skipSearch true.
  { name: 'image-gen', messages: [u('1', 'draw me a watercolor fox')] },
  // Recency-sensitive standalone → needsRecent true.
  {
    name: 'recent-price',
    messages: [u('1', 'what is the current price of bitcoin')]
  },
  // Stable-fact standalone → needsRecent false.
  {
    name: 'stable-fact',
    messages: [u('1', 'what year did the Roman Empire fall')]
  }
]
```

- [ ] **Step 2: Write the eval runner.** Create `scripts/eval/classifier-eval.ts`:

```ts
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { classifyQuery } from '@/lib/agents/query-classifier'

import { CASES } from './classifier-cases'

const BASELINE = path.join(__dirname, 'classifier-baseline.json')

type Result = {
  skipSearch: boolean
  standaloneQuery: string
  needsRecent: boolean
  intent: string
}

async function run(): Promise<Record<string, Result>> {
  const out: Record<string, Result> = {}
  for (const c of CASES) {
    const r = await classifyQuery({ messages: c.messages })
    out[c.name] = {
      skipSearch: r.skipSearch,
      standaloneQuery: r.standaloneQuery,
      needsRecent: r.needsRecent,
      intent: r.intent
    }
    console.log(
      `  ${c.name}: skip=${r.skipSearch} recent=${r.needsRecent} intent=${r.intent} q="${r.standaloneQuery}"`
    )
  }
  return out
}

async function main() {
  const mode = process.argv[2]
  if (mode === '--capture') {
    const results = await run()
    await fs.writeFile(BASELINE, JSON.stringify(results, null, 2) + '\n')
    console.log(`\nBaseline written: ${BASELINE}`)
    return
  }
  if (mode === '--check') {
    const baseline: Record<string, Result> = JSON.parse(
      await fs.readFile(BASELINE, 'utf8')
    )
    const now = await run()
    let failed = 0
    console.log('\n=== parity vs baseline ===')
    for (const c of CASES) {
      const b = baseline[c.name]
      const n = now[c.name]
      const decisionOk =
        b.skipSearch === n.skipSearch &&
        b.needsRecent === n.needsRecent &&
        b.intent === n.intent
      const queryOk = b.standaloneQuery === n.standaloneQuery
      if (decisionOk && queryOk) {
        console.log(`  PASS ${c.name}`)
      } else {
        failed++
        console.log(
          `  FAIL ${c.name}: decision=${decisionOk} query=${queryOk}\n    baseline: ${JSON.stringify(b)}\n    now:      ${JSON.stringify(n)}`
        )
      }
    }
    if (failed > 0) {
      console.error(`\n${failed} case(s) drifted — DO NOT SHIP.`)
      process.exit(1)
    }
    console.log('\nAll cases parity-clean.')
    return
  }
  console.error('usage: classifier-eval.ts --capture | --check')
  process.exit(2)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
```

- [ ] **Step 3: Capture the OLD baseline.** Run against the CURRENT (unchanged) classifier:

Run: `bun run scripts/eval/classifier-eval.ts --capture`
Expected: prints one line per case; writes `classifier-baseline.json`. Sanity-check the printed output makes sense (standalone questions have `q` ≈ the input; follow-ups have a rewritten `q`; greetings/confirms/image have `skip=true`). This is the OLD classifier's behavior — the ground truth the NEW version must match.

- [ ] **Step 4: Commit the harness + baseline.**

```bash
git add scripts/eval/classifier-cases.ts scripts/eval/classifier-eval.ts scripts/eval/classifier-baseline.json
git commit -m "Add classifier eval harness + OLD baseline for token-trim parity gate"
```

---

### Task 2: Implement the token-trim in the classifier

**Files:**

- Modify: `lib/agents/query-classifier.ts`
- Test: `lib/agents/__tests__/query-classifier-normalize.test.ts` (new)

**Interfaces:**

- Consumes: nothing new.
- Produces: `resolveStandaloneQuery(raw: { queryIsStandalone: boolean; standaloneQuery: string }, latestMessage: string): string` — exported pure helper; returns `latestMessage` when `queryIsStandalone` (or when the rewrite is empty), else the rewrite. `QueryClassification` unchanged.

- [ ] **Step 1: Write the failing unit test** — create `lib/agents/__tests__/query-classifier-normalize.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { resolveStandaloneQuery } from '../query-classifier'

describe('resolveStandaloneQuery', () => {
  it('returns the raw message when the query is standalone', () => {
    expect(
      resolveStandaloneQuery(
        { queryIsStandalone: true, standaloneQuery: '' },
        'best vector db 2026'
      )
    ).toBe('best vector db 2026')
  })

  it('returns the rewrite when the query is not standalone', () => {
    expect(
      resolveStandaloneQuery(
        { queryIsStandalone: false, standaloneQuery: 'pricing of Pinecone' },
        'what about its pricing?'
      )
    ).toBe('pricing of Pinecone')
  })

  it('falls back to the raw message if a non-standalone rewrite is empty', () => {
    expect(
      resolveStandaloneQuery(
        { queryIsStandalone: false, standaloneQuery: '' },
        'raw message'
      )
    ).toBe('raw message')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test lib/agents/__tests__/query-classifier-normalize.test.ts`
Expected: FAIL — `resolveStandaloneQuery` not exported.

- [ ] **Step 3: Implement.** In `lib/agents/query-classifier.ts`:

(a) Add `queryIsStandalone` to `classifierSchema` (the LLM output schema at ~L72), keeping the other fields:

```ts
const classifierSchema = z.object({
  skipSearch: z.boolean(),
  queryIsStandalone: z.boolean(),
  standaloneQuery: z.string(),
  needsRecent: z.boolean(),
  intent: z.enum(SEARCH_INTENTS)
})
```

(b) Add the exported resolver (top-level, near the schema):

```ts
/**
 * Resolve the standalone query the rest of the app consumes. When the classifier
 * flags the latest message as already self-contained, use it verbatim (the model
 * emits an empty standaloneQuery to save tokens); otherwise use the rewrite,
 * falling back to the raw message if the rewrite is empty. Keeps the public
 * QueryClassification.standaloneQuery contract identical to before.
 */
export function resolveStandaloneQuery(
  raw: { queryIsStandalone: boolean; standaloneQuery: string },
  latestMessage: string
): string {
  if (raw.queryIsStandalone) return latestMessage
  return raw.standaloneQuery || latestMessage
}
```

(c) Add ONE instruction to `CLASSIFIER_SYSTEM_PROMPT` describing `queryIsStandalone` (append near where `standaloneQuery` is described — do NOT alter any existing rule text). Add:

```
You also set queryIsStandalone: true when the latest user message is ALREADY a self-contained search query that needs no rewriting (a new, fully-specified question that stands on its own). When queryIsStandalone is true, output standaloneQuery as an empty string "". Set queryIsStandalone: false ONLY when the message depends on earlier context (pronouns like "it/he/they", ellipsis, "what about X") and must be rewritten into a standalone query — put that rewrite in standaloneQuery.
```

(d) Fix the empty-query guard AND normalize the return. The current success path is (~L218-222):

```ts
if (!classification || !classification.standaloneQuery.trim()) {
  return fallback
}

return classification
```

⚠️ The `!classification.standaloneQuery.trim()` check MUST be removed: with the trim, a standalone turn _deliberately_ emits `standaloneQuery: ""`, so this guard would wrongly send every standalone turn to the always-search fallback (breaking skipSearch → un-gating recall → a real regression). Replace the whole block with:

```ts
if (!classification) {
  return fallback
}

return {
  skipSearch: classification.skipSearch,
  standaloneQuery: resolveStandaloneQuery(classification, latestMessage),
  needsRecent: classification.needsRecent,
  intent: classification.intent
}
```

The resolver already handles the empty-query case (standalone → `latestMessage`; non-standalone with empty rewrite → `latestMessage`), so dropping the emptiness guard loses no safety. `queryIsStandalone` is NOT part of the returned object. The `fallback` object at ~L174 is unchanged.

- [ ] **Step 4: Run the unit test + typecheck.**

Run: `bun run test lib/agents/__tests__/query-classifier-normalize.test.ts && bun typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Full gates + commit.**

```bash
bun lint && bunx prettier --write lib/agents/query-classifier.ts lib/agents/__tests__/query-classifier-normalize.test.ts && bun run format:check && bun run test
git add lib/agents/query-classifier.ts lib/agents/__tests__/query-classifier-normalize.test.ts
git commit -m "Classifier: emit queryIsStandalone flag to trim standaloneQuery tokens"
```

---

### Task 3: Run the quality gate + measure the win

**Files:** none — verification only (the binding quality gate).

- [ ] **Step 1: Parity check — NEW classifier vs OLD baseline.**

Run: `bun run scripts/eval/classifier-eval.ts --check`
Expected: `All cases parity-clean.` and exit 0. If ANY case prints `FAIL` (decision or query drift), the trim is not safe — **STOP, do not ship**, and report the failing cases + their diffs to the controller. The controller decides whether to iterate the prompt (re-do Task 2 step 3c) or abandon the trim. Do NOT proceed while any case fails.

- [ ] **Step 2: Measure the token win.** Add a one-off print of `eval_count` is not necessary — instead confirm the win qualitatively from the classifier's behavior: on the standalone cases the model now emits `standaloneQuery: ""` (fewer tokens). Note in the report that the win is realized on the standalone-flagged cases; the exact per-turn `classify_ms` reduction is confirmed from staging `[latency]` logs in Step 3.

- [ ] **Step 3: Staging verify (probe-free).**

```bash
DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder bun run build
docker compose -f docker-compose.yaml -f docker-compose.admin-feature.yaml up -d --build ask
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3739   # 200
```

Send ONE trivial standalone `skipSearch` turn (e.g. "what is 8 times 7?") — hits zero engines — then read its `[latency]` line and confirm the answer is correct:

```bash
docker logs ask-admin-feature --since 5m 2>&1 | grep '\[latency\]'
```

Record the `classify_ms` (compare to the ~1.6s granite warm baseline). NEVER fire a test search — standalone-turn numbers from organic logs otherwise.

- [ ] **Step 4: Report.** Summarize: parity result (must be clean), the observed standalone `classify_ms`, and confirm the answer rendered. Deploy to production only on explicit operator approval.

---

## Self-Review Notes

- Spec coverage: queryIsStandalone flag + empty standaloneQuery (Task 2 schema/prompt), normalization preserving the contract (Task 2 resolver), quality gate with decision+query parity (Tasks 1 & 3), token win + staging measure (Task 3). Blast-radius-of-one-file honored (only query-classifier.ts + eval scripts + the new unit test).
- The eval is temperature-0 deterministic, so baseline vs check is a fair comparison; it fires granite calls (local LLM), never searches.
- Type consistency: `resolveStandaloneQuery` signature identical between its definition (Task 2) and its unit test (Task 2 step 1).
- The binding gate lives in Task 3 Step 1 — the plan explicitly forbids shipping on any parity FAIL.
