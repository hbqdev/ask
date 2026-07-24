# Recall Gating + Overlap (Phase A.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop making the user wait on cross-chat recall when it can't help — skip it on `skipSearch` turns, and overlap it with the classifier on the turns where it does run — with no change to recall depth or answer quality.

**Architecture:** A pure `chooseRecall` decision helper (`gated`/`speculative`/`refetch`) plus wiring in `lib/streaming/create-chat-stream-response.ts`: start a speculative recall on the raw message alongside the classifier, then after classification resolves, gate/use/refetch per the decision. `getRecallInjection` is unchanged and already fail-safe (never rejects).

**Tech Stack:** TypeScript, Next.js streaming, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-24-recall-gating-overlap-design.md`.

## Global Constraints

- NEVER add `Co-Authored-By` or any AI-attribution trailer to commits.
- Format single files with `bunx prettier --write <file>` — never `bun run format`.
- Tests: `bun run test` (Vitest), never `bun test`.
- **No change to recall depth/quality:** recall still searches all history when it runs; only _whether/when_ it runs changes. Do not touch `getRecallInjection`, `recall-search.ts`, the recall chips, or the researcher prompt injection.
- **Zero regression on the refetch path:** when `standaloneQuery` differs from the raw message, behavior must equal today's (recall on `standaloneQuery`).
- Verification is **probe-free** — a `skipSearch` turn (hits zero engines) + reading `[latency]` from organic logs. NEVER a test search.
- `getRecallInjection(userId, query, chatId)` returns `{ block: string; hits: RecallHit[] }`; the empty value is `{ block: '', hits: [] }`. It never rejects.

---

### Task 1: chooseRecall decision helper

**Files:**

- Create: `lib/streaming/helpers/choose-recall.ts`
- Test: `lib/streaming/helpers/__tests__/choose-recall.test.ts`

**Interfaces:**

- Produces:
  - `type RecallDecision = 'gated' | 'speculative' | 'refetch'`
  - `chooseRecall(args: { skipSearch: boolean; standaloneQuery: string; latestMessageText: string }): RecallDecision`
  - Rules: `skipSearch` → `'gated'`; else the effective query `standaloneQuery || latestMessageText` equals `latestMessageText` → `'speculative'`; else → `'refetch'`. (The `||` fallback means an empty `standaloneQuery` resolves to `'speculative'`, since the effective query is then the raw message.)

- [ ] **Step 1: Write the failing test** — create `lib/streaming/helpers/__tests__/choose-recall.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { chooseRecall } from '../choose-recall'

describe('chooseRecall', () => {
  it('gates recall on skipSearch turns regardless of query', () => {
    expect(
      chooseRecall({
        skipSearch: true,
        standaloneQuery: 'anything',
        latestMessageText: 'anything'
      })
    ).toBe('gated')
    expect(
      chooseRecall({
        skipSearch: true,
        standaloneQuery: 'rewritten differently',
        latestMessageText: 'hi'
      })
    ).toBe('gated')
  })

  it('uses the speculative result when the standalone query equals the raw message', () => {
    expect(
      chooseRecall({
        skipSearch: false,
        standaloneQuery: 'best vector db 2026',
        latestMessageText: 'best vector db 2026'
      })
    ).toBe('speculative')
  })

  it('treats an empty standalone query as speculative (falls back to the raw message)', () => {
    expect(
      chooseRecall({
        skipSearch: false,
        standaloneQuery: '',
        latestMessageText: 'best vector db 2026'
      })
    ).toBe('speculative')
  })

  it('refetches when the standalone query differs from the raw message', () => {
    expect(
      chooseRecall({
        skipSearch: false,
        standaloneQuery: 'what is the pricing of Pinecone',
        latestMessageText: 'what about its pricing?'
      })
    ).toBe('refetch')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/streaming/helpers/__tests__/choose-recall.test.ts`
Expected: FAIL — module `../choose-recall` not found.

- [ ] **Step 3: Implement** — create `lib/streaming/helpers/choose-recall.ts`:

```ts
// Decides how recall runs for a turn, given the classifier's output.
//   gated       — skipSearch turn: recall can't help (the answer comes from
//                 this chat's own context), so don't wait for it.
//   speculative — the classifier's standalone query equals the raw message,
//                 so a recall started on the raw message (before the classifier
//                 resolved) is valid — use it, having overlapped the classifier.
//   refetch     — the standalone query differs (context resolution), so the
//                 speculative recall used the wrong query; run recall on the
//                 resolved query (this equals today's behavior — no regression).
export type RecallDecision = 'gated' | 'speculative' | 'refetch'

export function chooseRecall(args: {
  skipSearch: boolean
  standaloneQuery: string
  latestMessageText: string
}): RecallDecision {
  if (args.skipSearch) return 'gated'
  const effectiveQuery = args.standaloneQuery || args.latestMessageText
  return effectiveQuery === args.latestMessageText ? 'speculative' : 'refetch'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/streaming/helpers/__tests__/choose-recall.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/streaming/helpers/choose-recall.ts lib/streaming/helpers/__tests__/choose-recall.test.ts
git commit -m "Add chooseRecall decision helper (gate/overlap/refetch)"
```

---

### Task 2: Wire speculative recall + gating into the chat stream

**Files:**

- Modify: `lib/streaming/create-chat-stream-response.ts`

**Interfaces:**

- Consumes: `chooseRecall` (Task 1); `getRecallInjection` (already imported).
- Produces: no exported surface change.

No new unit test (chooseRecall is unit-tested; the wiring is verified by the whole suite + typecheck + staging, matching Phase A Task 3's posture). MUST NOT change the refetch path's behavior vs. today, the recall chips, or the researcher injection.

- [ ] **Step 1: Add the import.** Alongside the other `./helpers/*` imports near the top:

```ts
import { chooseRecall } from './helpers/choose-recall'
```

(Run `bun lint --fix` after editing to settle import order.)

- [ ] **Step 2: Start the speculative recall before the stream.** Immediately after the `classificationPromise` is created (the `const classificationPromise = bypassClassifier ? ... : classifyQuery(...)` block, ~L161-168), add:

```ts
// Start recall speculatively on the raw message, concurrent with the
// classifier, so a research turn whose standalone query matches the raw
// message pays no serial recall wait (see chooseRecall). getRecallInjection
// is fail-safe (never rejects); on a gated/refetch turn this result is
// simply not awaited. userId-less turns have no recall.
const speculativeRecall = userId
  ? getRecallInjection(userId, latestMessageText, chatId)
  : Promise.resolve({ block: '', hits: [] })
```

- [ ] **Step 3: Replace the serial recall block with the decision.** The current block (~L331-341) is:

```ts
const recallStart = performance.now()
const recall = await getRecallInjection(
  userId,
  classification?.standaloneQuery || latestMessageText,
  chatId
)
latency.mark('recall_ms', performance.now() - recallStart)
```

Replace it with:

```ts
const recallStart = performance.now()
const recallDecision = chooseRecall({
  skipSearch: classification.skipSearch,
  standaloneQuery: classification.standaloneQuery,
  latestMessageText
})
const recall =
  recallDecision === 'gated'
    ? { block: '', hits: [] }
    : recallDecision === 'speculative'
      ? await speculativeRecall
      : await getRecallInjection(userId, classification.standaloneQuery, chatId)
latency.mark('recall_ms', performance.now() - recallStart)
```

Notes for the implementer:

- The `recall.hits`/`recall.block` consumers below (the chips `writer.write` and `recallBlock: recall.block`) are unchanged — `recall` keeps the same `{ block, hits }` shape in all three branches.
- On `gated`/`refetch`, `speculativeRecall` is a floating fail-safe promise (it resolves and is discarded; it never rejects, so no unhandled rejection). Do NOT add a `.catch` — `getRecallInjection` already swallows errors.
- The `refetch` branch calls `getRecallInjection(userId, classification.standaloneQuery, chatId)` — note `classification.standaloneQuery` here is guaranteed truthy in the refetch branch (if it were falsy, `chooseRecall` returns `speculative`), so this matches the old `standaloneQuery || latestMessageText` result exactly.

- [ ] **Step 4: Gates.**

```bash
bun typecheck && bun lint && bunx prettier --write lib/streaming/create-chat-stream-response.ts && bun run format:check && bun run test
```

Expected: all pass; test count unchanged except +4 from Task 1.

- [ ] **Step 5: Commit**

```bash
git add lib/streaming/create-chat-stream-response.ts
git commit -m "Gate recall on skipSearch and overlap it with the classifier"
```

---

### Task 3: Staging verification (probe-free)

**Files:** none — verification only.

- [ ] **Step 1: Full gates + build.**

```bash
bun typecheck && bun lint && bun run format:check && bun run test
DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder bun run build
```

- [ ] **Step 2: Deploy to staging.**

```bash
docker compose -f docker-compose.yaml -f docker-compose.admin-feature.yaml up -d --build ask
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3739   # expect 200
```

- [ ] **Step 3: Verify WITHOUT search traffic.**

Send ONE trivial `skipSearch` message in the staging UI (e.g. "what's 12 times 4?") — hits zero engines. Then:

```bash
docker logs ask-admin-feature --since 5m 2>&1 | grep '\[latency\]'
```

Expected: the `[latency]` line for that turn shows **`recall_ms` ≈ 0** (gated), versus ~4300 in the Phase A baseline — and the answer renders correctly. For a `speculative`/`refetch` turn's numbers, read from organic traffic logs; do NOT fire a test search. Record the before/after `recall_ms` and `ttft_ms` in the report.

- [ ] **Step 4: Report.** Summarize the `recall_ms`/`ttft_ms` delta on the trivial turn. Deploy to production only on explicit operator approval.

---

## Self-Review Notes

- Spec coverage: gating (Task 2 `gated` branch), overlap (`speculative` branch), no-regression refetch (`refetch` branch = old behavior); decision logic unit-tested (Task 1); lookback-unchanged (no touch to recall-search); probe-free verification (Task 3).
- Known tradeoff (documented, accepted): on `gated`/`refetch` turns the speculative recall runs briefly in the background (wasted reranker work, non-blocking, local fleet GPU). This buys the user-facing TTFT win, which is the goal. Not a correctness issue.
- Type consistency: `chooseRecall` signature identical between Task 1 and Task 2; `recall` keeps `{ block, hits }` in all branches.
