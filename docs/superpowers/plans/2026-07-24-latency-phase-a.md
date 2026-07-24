# Latency Optimization — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit one structured `[latency]` line per chat turn (prepare, classify, recall, attachments, true TTFT, total) so every later optimization is measured, not guessed — with zero change to answer output.

**Architecture:** A small `LatencyTracker` accumulates named stage durations and a first-token timestamp during a turn, then emits a single JSON line in `onFinish`. It is wired into `lib/streaming/create-chat-stream-response.ts` at the timing boundaries that already exist there (`prepareStart`, `classifyStart`, `attachmentsStart`) plus a passthrough `TransformStream` tap on the researcher's UI-message stream for true time-to-first-token. No behavior changes.

**Tech Stack:** TypeScript, Next.js streaming (`createUIMessageStream`), Vitest, Web Streams `TransformStream`.

**Spec:** `docs/superpowers/specs/2026-07-24-latency-optimization-design.md` (Phase A).

## Global Constraints

- NEVER add `Co-Authored-By` or any AI-attribution trailer to commits.
- Format single files with `bunx prettier --write <file>` — never `bun run format`.
- Tests run with `bun run test` (Vitest), never `bun test`.
- **Zero behavior change:** the `[latency]` line is additive; answer content, streamed parts, and DB persistence must be byte-identical to before. The TTFT tap is a passthrough — it must enqueue every chunk unchanged and never swallow or reorder.
- The line emits by default (one concise line per turn is negligible cost and the whole point is to see numbers in prod) — do NOT gate it behind `ENABLE_PERF_LOGGING`.
- Scope is the **orchestration-visible** stages in `create-chat-stream-response.ts`. Search-internal stages (search/crawl/rerank/expand) live deep in the researcher's tool calls and are a documented follow-up — do NOT try to thread them out in this phase.

---

### Task 1: LatencyTracker helper

**Files:**

- Create: `lib/streaming/latency-tracker.ts`
- Test: `lib/streaming/__tests__/latency-tracker.test.ts`

**Interfaces:**

- Produces:
  - `class LatencyTracker`
  - `constructor(meta: { chatId?: string | null; mode: string })` — stamps the turn start.
  - `mark(name: string, ms: number): void` — record a stage duration (rounded).
  - `markFirstToken(): void` — stamp the first-token time once (idempotent; later calls no-op).
  - `emit(extra: { skipSearch?: boolean | null }): void` — log one line `[latency] {json}` with all marks, `ttft_ms` (null if no token emitted), `total_ms`, `mode`, `chatId`, `skipSearch`.
  - Static test seam: `constructor` accepts an optional 3rd arg `now: () => number` (defaults to `() => performance.now()`) and an optional 4th `sink: (line: string) => void` (defaults to `(l) => console.log(l)`) so tests are deterministic without stubbing globals.

- [ ] **Step 1: Write the failing test** — create `lib/streaming/__tests__/latency-tracker.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { LatencyTracker } from '../latency-tracker'

// Deterministic clock: each call returns the next queued value.
function fakeClock(values: number[]): () => number {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

describe('LatencyTracker', () => {
  it('emits one [latency] line with marks, ttft, total, and meta', () => {
    const lines: string[] = []
    // start=0, markFirstToken reads 800, emit reads 1500
    const t = new LatencyTracker(
      { chatId: 'c1', mode: 'balanced' },
      fakeClock([0, 800, 1500]),
      l => lines.push(l)
    )
    t.mark('classify_ms', 120)
    t.mark('recall_ms', 40)
    t.markFirstToken()
    t.emit({ skipSearch: false })

    expect(lines).toHaveLength(1)
    expect(lines[0].startsWith('[latency] ')).toBe(true)
    const obj = JSON.parse(lines[0].slice('[latency] '.length))
    expect(obj).toMatchObject({
      chatId: 'c1',
      mode: 'balanced',
      classify_ms: 120,
      recall_ms: 40,
      ttft_ms: 800,
      total_ms: 1500,
      skipSearch: false
    })
  })

  it('reports ttft_ms null when no token was emitted, and null chatId', () => {
    const lines: string[] = []
    const t = new LatencyTracker(
      { chatId: null, mode: 'speed' },
      fakeClock([0, 900]),
      l => lines.push(l)
    )
    t.emit({ skipSearch: null })
    const obj = JSON.parse(lines[0].slice('[latency] '.length))
    expect(obj.ttft_ms).toBeNull()
    expect(obj.chatId).toBeNull()
    expect(obj.total_ms).toBe(900)
  })

  it('markFirstToken is idempotent (keeps the first stamp)', () => {
    const lines: string[] = []
    const t = new LatencyTracker(
      { chatId: 'c1', mode: 'balanced' },
      fakeClock([0, 500, 999, 2000]),
      l => lines.push(l)
    )
    t.markFirstToken() // reads 500
    t.markFirstToken() // reads 999 — must be ignored
    t.emit({}) // reads 2000
    const obj = JSON.parse(lines[0].slice('[latency] '.length))
    expect(obj.ttft_ms).toBe(500)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/streaming/__tests__/latency-tracker.test.ts`
Expected: FAIL — module `../latency-tracker` not found.

- [ ] **Step 3: Implement** — create `lib/streaming/latency-tracker.ts`:

```ts
// One structured latency line per chat turn. Additive telemetry only — it
// never touches answer content. Emitted by default (one line/turn is cheap
// and the point is to see numbers in prod), unlike the opt-in perfLog helpers.

type Meta = { chatId?: string | null; mode: string }

export class LatencyTracker {
  private readonly startedAt: number
  private readonly marks: Record<string, number> = {}
  private firstTokenAt: number | null = null

  constructor(
    private readonly meta: Meta,
    private readonly now: () => number = () => performance.now(),
    private readonly sink: (line: string) => void = line => console.log(line)
  ) {
    this.startedAt = this.now()
  }

  /** Record a completed stage duration (ms). */
  mark(name: string, ms: number): void {
    this.marks[name] = Math.round(ms)
  }

  /** Stamp the moment the first output chunk reached the client. Idempotent. */
  markFirstToken(): void {
    if (this.firstTokenAt === null) this.firstTokenAt = this.now()
  }

  /** Emit the single per-turn line. */
  emit(extra: { skipSearch?: boolean | null }): void {
    const total = Math.round(this.now() - this.startedAt)
    const ttft =
      this.firstTokenAt === null
        ? null
        : Math.round(this.firstTokenAt - this.startedAt)
    this.sink(
      `[latency] ${JSON.stringify({
        chatId: this.meta.chatId ?? null,
        mode: this.meta.mode,
        ...this.marks,
        ttft_ms: ttft,
        total_ms: total,
        skipSearch: extra.skipSearch ?? null
      })}`
    )
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/streaming/__tests__/latency-tracker.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/streaming/latency-tracker.ts lib/streaming/__tests__/latency-tracker.test.ts
git commit -m "Add per-turn LatencyTracker (one structured [latency] line)"
```

---

### Task 2: First-token stream tap

**Files:**

- Create: `lib/streaming/helpers/first-chunk-timer.ts`
- Test: `lib/streaming/helpers/__tests__/first-chunk-timer.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `firstChunkTimer<T>(onFirst: () => void): TransformStream<T, T>` — a passthrough transform that calls `onFirst()` exactly once, when the first chunk passes, then forwards every chunk unchanged.

- [ ] **Step 1: Write the failing test** — create `lib/streaming/helpers/__tests__/first-chunk-timer.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { firstChunkTimer } from '../first-chunk-timer'

async function drain<T>(rs: ReadableStream<T>): Promise<T[]> {
  const out: T[] = []
  const reader = rs.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    out.push(value)
  }
  return out
}

function fromArray<T>(items: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const it of items) controller.enqueue(it)
      controller.close()
    }
  })
}

describe('firstChunkTimer', () => {
  it('fires onFirst exactly once and forwards all chunks unchanged', async () => {
    let calls = 0
    const chunks = [{ a: 1 }, { b: 2 }, { c: 3 }]
    const out = await drain(
      fromArray(chunks).pipeThrough(firstChunkTimer(() => calls++))
    )
    expect(calls).toBe(1)
    expect(out).toEqual(chunks)
  })

  it('does not fire onFirst for an empty stream', async () => {
    let calls = 0
    const out = await drain(
      fromArray<number>([]).pipeThrough(firstChunkTimer(() => calls++))
    )
    expect(calls).toBe(0)
    expect(out).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/streaming/helpers/__tests__/first-chunk-timer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `lib/streaming/helpers/first-chunk-timer.ts`:

```ts
// Passthrough transform that stamps the first chunk. Used to measure true
// time-to-first-token on the researcher's UI-message stream without altering
// the bytes: every chunk is forwarded unchanged; onFirst() fires once.

export function firstChunkTimer<T>(onFirst: () => void): TransformStream<T, T> {
  let fired = false
  return new TransformStream<T, T>({
    transform(chunk, controller) {
      if (!fired) {
        fired = true
        onFirst()
      }
      controller.enqueue(chunk)
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/streaming/helpers/__tests__/first-chunk-timer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/streaming/helpers/first-chunk-timer.ts lib/streaming/helpers/__tests__/first-chunk-timer.test.ts
git commit -m "Add firstChunkTimer passthrough transform for TTFT measurement"
```

---

### Task 3: Wire instrumentation into the chat stream

**Files:**

- Modify: `lib/streaming/create-chat-stream-response.ts`

**Interfaces:**

- Consumes: `LatencyTracker` (Task 1), `firstChunkTimer` (Task 2).
- Produces: no exported surface change; a `[latency]` line per turn.

This task has no new unit test (the pieces are unit-tested in Tasks 1–2; this is wiring verified by the whole-suite gate + a staging smoke). It MUST keep answer output identical.

- [ ] **Step 1: Add imports.** After the existing `perf-logging` import (line ~35):

```ts
import { perfLog, perfTime } from '../utils/perf-logging'
import { firstChunkTimer } from './helpers/first-chunk-timer'
import { LatencyTracker } from './latency-tracker'
```

(Place `firstChunkTimer` / `LatencyTracker` in correct `simple-import-sort` order; run `bun lint --fix` after editing to settle it.)

- [ ] **Step 2: Create the tracker at turn start.** Immediately after `const prepareStart = performance.now()` (line ~135), add:

```ts
const latency = new LatencyTracker({ chatId, mode: searchMode })
```

Then after `const messagesToModel = await prepareMessages(context, message)` and its `perfTime(...)` (line ~140), add:

```ts
latency.mark('prepare_ms', performance.now() - prepareStart)
```

- [ ] **Step 3: Mark classify + recall.** Where `classification = await classificationPromise` resolves (line ~320), immediately after that line add:

```ts
latency.mark('classify_ms', performance.now() - classifyStart)
```

Wrap the recall call (lines ~325-329) with a timer. Replace:

```ts
const recall = await getRecallInjection(
  userId,
  classification?.standaloneQuery || latestMessageText,
  chatId
)
```

with:

```ts
const recallStart = performance.now()
const recall = await getRecallInjection(
  userId,
  classification?.standaloneQuery || latestMessageText,
  chatId
)
latency.mark('recall_ms', performance.now() - recallStart)
```

- [ ] **Step 4: Mark attachments (only when there were attachments).** Inside the existing `if (attachmentCount > 0) { ... }` block that writes the `done` attachments part (line ~236), add after that `writer.write`:

```ts
latency.mark('attachments_ms', performance.now() - attachmentsStart)
```

- [ ] **Step 5: Tap TTFT on the researcher stream.** Replace the final merge (line ~425):

```ts
writer.merge(result.toUIMessageStream({ sendStart: false }))
```

with:

```ts
writer.merge(
  result
    .toUIMessageStream({ sendStart: false })
    .pipeThrough(firstChunkTimer(() => latency.markFirstToken()))
)
```

- [ ] **Step 6: Emit the line in onFinish.** Inside `onFinish`, immediately after the existing `perfTime('researchAgent.stream completed', llmStart)` (line ~429), add:

```ts
latency.emit({ skipSearch: classification?.skipSearch ?? null })
```

(Place it before the `if (isAborted || !responseMessage) return` so an aborted turn still logs its latency — an abort is exactly a turn we want timing for.)

- [ ] **Step 7: Typecheck, lint, format, full suite.**

```bash
bun typecheck
bun lint
bunx prettier --write lib/streaming/create-chat-stream-response.ts
bun run format:check
bun run test
```

Expected: typecheck clean, lint 0 errors, format clean, all tests pass (existing count + the 5 new from Tasks 1–2).

- [ ] **Step 8: Commit**

```bash
git add lib/streaming/create-chat-stream-response.ts
git commit -m "Emit a per-turn [latency] line from the chat stream"
```

---

### Task 4: Staging verification (zero-behavior-change proof)

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

- [ ] **Step 3: Verify WITHOUT generating search traffic (bot-detection safe).**

⚠️ **Do NOT run search queries to test this.** Staging shares the real search
infra (standalone SearXNG, degoog, the shared CSE CX, the Brave/Tavily APIs),
so a test _search_ adds pressure to an already-flagged IP and the shared CX —
exactly what tripped `too many requests` on 2026-07-24. The latency
instrumentation does NOT need a search to prove out:

1. **One NON-searching turn.** Send a single trivial chat message that the
   classifier will mark `skipSearch` (e.g. "say hi" / "what's 2+2") — this
   exercises the full latency path (prepare → classify → recall → TTFT tap →
   total) and hits ZERO search engines. Confirm the answer renders normally
   (no missing/duplicated content — proves the TTFT tap is a clean passthrough).
2. **Read the line from logs** (organic + the one test turn):

```bash
docker logs ask-admin-feature --since 10m 2>&1 | grep '\[latency\]'
```

Expected: a `[latency]` JSON line with `classify_ms`, `recall_ms`, `ttft_ms`,
`total_ms` populated and `skipSearch: true`. For a _searching_ turn's numbers,
read them from **organic traffic** logs (yours or a real user's) rather than
firing a test search. Record observed numbers in the build report — they are
the input to deciding Phase B/C.

- [ ] **Step 4: Report.** Summarize the observed `ttft_ms` / `classify_ms` / `recall_ms` / `total_ms` for both turn types for the operator. Deploy to production only on explicit approval.

---

## Deferred to a data-informed follow-up (NOT in this plan)

Per the spec's own guardrail ("Phase A's numbers gate whether the rest is worth its complexity"), these wait for the numbers this plan produces:

- **Recall/classification overlap** (spec Phase A item 2): only worth its
  complexity + wasted-embedding-on-mismatch if the measured `recall_ms` is
  material. Decide after Task 4.
- **Trim dead awaits** (spec Phase A item 3): the chain audit is cheap but
  should target whatever the numbers show as the largest pre-TTFT gap.
- **Search-internal stages** (search/crawl/rerank/expand): live in the
  researcher's tool calls, not this orchestration scope — separate
  instrumentation, naturally folded into Phase C when we touch search.

## Self-Review Notes

- Spec coverage: Phase A item 1 (structured line) = Tasks 1–3; TTFT via tap
  (Task 2). Items 2–3 explicitly deferred pending the measurements, with
  rationale (matches the spec's gating guardrail). Zero-behavior-change proven
  in Task 4.
- No placeholders; all code complete; TTFT tap is a verified passthrough.
- Type consistency: `LatencyTracker` / `firstChunkTimer` signatures match
  between their definition tasks and the wiring task.
