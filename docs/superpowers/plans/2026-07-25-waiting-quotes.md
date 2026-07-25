# Waiting Quotes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While Ask is working, show an elapsed timer and a rotating quote that reveals one word at a time with a different animation each time.

**Architecture:** A pure timing function decides how long each quote stays. A server route reads quotes from Couchbase (server-side only), caches a normalised pool in Redis for 24h, and serves batches; the client fetches one batch per page session and cycles it locally, so no network call happens while the user waits. A client component renders the reveal, the style rotation and the timer, and is dropped into the existing in-progress branch of the research indicator.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Vitest, `couchbase` ^4.4.5 (native SDK, server-only), existing local Redis.

**Spec:** `docs/superpowers/specs/2026-07-25-waiting-quotes-design.md`

## Global Constraints

- Timing constants, exact: reveal cadence `300`ms/word, reveal ceiling `6000`ms, reading rate `15` cps, pause beat `180`ms, tail `700 + words*125` capped at `3200`ms, floor `3000`ms, difficulty `clamp(chars/words/5.1, 0.9, 1.3)`, fade-out `420`ms, author delay `+150`ms after the last word.
- `onScreen = max(read, reveal + tail, floor)`. **No maximum** on `onScreen`.
- `perWord = min(300, 6000 / words)`; `revealMs` must never exceed `6000`.
- Pauses are the characters `[,;:.…—]`.
- **No length cap on the pool.** A 2-word and an 80-word quote are both valid.
- Couchbase credentials are **server-side only** — never reach the browser, never appear in a client bundle, never logged.
- Nothing in this feature may break a turn. Every failure path degrades to "no quote".
- Run tests with `bun run test` (never `bun test`). Format with `bunx prettier --write <file>` (never repo-wide `bun run format`).
- Existing indicator behaviour (glyph, rail, click-to-expand, step list) must not change.

---

## File Structure

| File                                      | Responsibility                                                   |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `lib/quotes/types.ts`                     | The `Quote` type, shared by every other file.                    |
| `lib/quotes/quote-timing.ts`              | Pure. Turns quote text into durations. No DOM, no I/O.           |
| `lib/quotes/quote-pool.ts`                | Pure. Validates, dedupes and shuffles raw rows into a pool.      |
| `lib/quotes/fallback-quotes.ts`           | Bundled constant used when Couchbase is unavailable.             |
| `lib/quotes/couchbase-quotes.ts`          | Server-only. Native SDK fetch. Never throws.                     |
| `app/api/quotes/route.ts`                 | Redis-cached batch endpoint with the degradation chain.          |
| `components/waiting-quote.tsx`            | Client. Reveal, style rotation, fade, elapsed timer.             |
| `app/globals.css`                         | The five reveal keyframes, beside the existing `.wb-rail` rules. |
| `components/research-process-section.tsx` | Wires the component into the in-progress branch.                 |

---

### Task 1: Timing function

**Files:**

- Create: `lib/quotes/types.ts`
- Create: `lib/quotes/quote-timing.ts`
- Test: `lib/quotes/__tests__/quote-timing.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `type Quote = { q: string; a: string }`; `quoteTiming(text: string): QuoteTiming` where `QuoteTiming = { words: number; chars: number; perWordMs: number; revealMs: number; tailMs: number; readMs: number; totalMs: number; governedBy: 'read' | 'reveal' | 'floor' }`.

- [ ] **Step 1: Write the failing test**

Create `lib/quotes/__tests__/quote-timing.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { quoteTiming } from '../quote-timing'

// Each row was tuned with the operator and signed off. Treat these as fixed.
const CASES: Array<{
  text: string
  words: number
  totalMs: number
  governedBy: 'read' | 'reveal' | 'floor'
}> = [
  {
    text: 'We are made of star-stuff.',
    words: 5,
    totalMs: 3000,
    governedBy: 'floor'
  },
  {
    text: 'Somewhere, something incredible is waiting to be known.',
    words: 8,
    totalMs: 5127,
    governedBy: 'read'
  },
  {
    text: 'Any sufficiently advanced technology is indistinguishable from magic.',
    words: 8,
    totalMs: 6160,
    governedBy: 'read'
  },
  {
    text: 'I have no special talent. I am only passionately curious.',
    words: 10,
    totalMs: 4950,
    governedBy: 'reveal'
  },
  {
    text: 'The universe is under no obligation to make sense to you.',
    words: 11,
    totalMs: 5375,
    governedBy: 'reveal'
  },
  {
    text: "The good thing about science is that it's true whether or not you believe in it.",
    words: 16,
    totalMs: 7500,
    governedBy: 'reveal'
  }
]

describe('quoteTiming', () => {
  for (const c of CASES) {
    it(`${c.words}w → ${(c.totalMs / 1000).toFixed(1)}s, governed by ${c.governedBy}`, () => {
      const t = quoteTiming(c.text)
      expect(t.words).toBe(c.words)
      expect(Math.round(t.totalMs)).toBe(c.totalMs)
      expect(t.governedBy).toBe(c.governedBy)
    })
  }

  it('keeps the 300ms cadence for quotes up to 20 words', () => {
    const t = quoteTiming('one two three four five six seven eight nine ten')
    expect(t.perWordMs).toBe(300)
  })

  it('tightens the cadence so a long quote still reveals within the ceiling', () => {
    // 40 words at a flat 300ms would be a 12s reveal; the ceiling is 6s.
    const text = Array.from({ length: 40 }, () => 'word').join(' ')
    const t = quoteTiming(text)
    expect(t.perWordMs).toBeLessThan(300)
    expect(t.revealMs).toBeLessThanOrEqual(6000)
  })

  it('never exceeds the reveal ceiling even at the longest quote in the pool', () => {
    const text = Array.from({ length: 80 }, () => 'word').join(' ')
    expect(quoteTiming(text).revealMs).toBeLessThanOrEqual(6000)
  })

  it('caps the tail so it cannot run away on long quotes', () => {
    const text = Array.from({ length: 80 }, () => 'word').join(' ')
    expect(quoteTiming(text).tailMs).toBe(3200)
  })

  it('never returns less than the floor', () => {
    expect(quoteTiming('Hi there.').totalMs).toBe(3000)
  })

  it('returns a zeroed result for empty text rather than dividing by zero', () => {
    const t = quoteTiming('   ')
    expect(t.words).toBe(0)
    expect(t.totalMs).toBe(3000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/quotes/__tests__/quote-timing.test.ts`
Expected: FAIL — cannot resolve `../quote-timing`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/quotes/types.ts`:

```ts
/** One quote as stored in Couchbase: `q` is the text, `a` the attribution. */
export type Quote = { q: string; a: string }
```

Create `lib/quotes/quote-timing.ts`:

```ts
// How long a quote stays on screen.
//
// Reading happens DURING the word-by-word reveal, not after it, so reveal time
// and reading time must not be summed — that double-counts and leaves long
// quotes sitting far too long. They compete instead, and the largest demand
// wins.

/** Reveal cadence for a normal-length quote. */
const REVEAL_PER_WORD_MS = 300
/** The pool runs to 80 words; at a flat cadence that is a 24s reveal. */
const REVEAL_CEILING_MS = 6000
/** Characters per second. Subtitling practice for adult viewers. */
const READ_CPS = 15
/** Added per punctuation mark — the pauses a reader actually takes. */
const PAUSE_MS = 180
const TAIL_BASE_MS = 700
const TAIL_PER_WORD_MS = 125
const TAIL_CEILING_MS = 3200
/** Nothing shows for less than this, however short. */
const FLOOR_MS = 3000
/** Average English word length, so difficulty is a ratio against normal. */
const AVG_WORD_CHARS = 5.1
const PAUSE_CHARS = /[,;:.…—]/g

export type QuoteTiming = {
  words: number
  chars: number
  perWordMs: number
  revealMs: number
  tailMs: number
  readMs: number
  totalMs: number
  governedBy: 'read' | 'reveal' | 'floor'
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

export function quoteTiming(text: string): QuoteTiming {
  const words = text.split(/\s+/).filter(Boolean).length
  const chars = text.length

  if (words === 0) {
    return {
      words: 0,
      chars,
      perWordMs: REVEAL_PER_WORD_MS,
      revealMs: 0,
      tailMs: TAIL_BASE_MS,
      readMs: 0,
      totalMs: FLOOR_MS,
      governedBy: 'floor'
    }
  }

  // Long quotes tighten their cadence so they always finish arriving promptly.
  const perWordMs = Math.min(REVEAL_PER_WORD_MS, REVEAL_CEILING_MS / words)
  const revealMs = words * perWordMs
  const tailMs = Math.min(
    TAIL_BASE_MS + words * TAIL_PER_WORD_MS,
    TAIL_CEILING_MS
  )

  const difficulty = clamp(chars / words / AVG_WORD_CHARS, 0.9, 1.3)
  const pauses = (text.match(PAUSE_CHARS) ?? []).length
  const readMs = (chars / READ_CPS) * 1000 * difficulty + pauses * PAUSE_MS

  const revealTotal = revealMs + tailMs
  const totalMs = Math.max(readMs, revealTotal, FLOOR_MS)
  const governedBy =
    totalMs === readMs ? 'read' : totalMs === revealTotal ? 'reveal' : 'floor'

  return {
    words,
    chars,
    perWordMs,
    revealMs,
    tailMs,
    readMs,
    totalMs,
    governedBy
  }
}

export const QUOTE_FADE_OUT_MS = 420
export const QUOTE_AUTHOR_DELAY_MS = 150
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/quotes/__tests__/quote-timing.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Format, typecheck, commit**

```bash
bunx prettier --write lib/quotes/types.ts lib/quotes/quote-timing.ts lib/quotes/__tests__/quote-timing.test.ts
bun typecheck
git add lib/quotes/types.ts lib/quotes/quote-timing.ts lib/quotes/__tests__/quote-timing.test.ts
git commit -m "Add quote timing: read, reveal and floor compete for time on screen"
```

---

### Task 2: Pool normalisation and fallback set

**Files:**

- Create: `lib/quotes/quote-pool.ts`
- Create: `lib/quotes/fallback-quotes.ts`
- Test: `lib/quotes/__tests__/quote-pool.test.ts`

**Interfaces:**

- Consumes: `Quote` from `lib/quotes/types.ts`.
- Produces: `acceptQuote(row: unknown): row is Quote`; `normalizePool(rows: unknown[], random?: () => number): Quote[]`; `FALLBACK_QUOTES: Quote[]`.

- [ ] **Step 1: Write the failing test**

Create `lib/quotes/__tests__/quote-pool.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { FALLBACK_QUOTES } from '../fallback-quotes'
import { acceptQuote, normalizePool } from '../quote-pool'

describe('acceptQuote', () => {
  it('accepts a well-formed quote', () => {
    expect(
      acceptQuote({ q: 'We are made of star-stuff.', a: 'Carl Sagan' })
    ).toBe(true)
  })

  it('accepts both extremes of length — there is no length cap', () => {
    expect(acceptQuote({ q: 'Be curious.', a: 'Someone' })).toBe(true)
    const long = Array.from({ length: 80 }, () => 'word').join(' ')
    expect(acceptQuote({ q: long, a: 'Someone' })).toBe(true)
  })

  it('rejects rows missing text or attribution', () => {
    expect(acceptQuote({ q: '', a: 'Carl Sagan' })).toBe(false)
    expect(acceptQuote({ q: 'Something', a: '   ' })).toBe(false)
    expect(acceptQuote({ q: 'Something' })).toBe(false)
    expect(acceptQuote(null)).toBe(false)
    expect(acceptQuote({ q: 5, a: 'x' })).toBe(false)
  })
})

describe('normalizePool', () => {
  it('drops invalid rows and keeps the valid ones', () => {
    const pool = normalizePool(
      [{ q: 'One.', a: 'A' }, null, { q: '', a: 'B' }, { q: 'Two.', a: 'C' }],
      () => 0
    )
    expect(pool.map(p => p.q)).toEqual(['One.', 'Two.'])
  })

  it('dedupes case-insensitively on the text', () => {
    const pool = normalizePool(
      [
        { q: 'We are made of star-stuff.', a: 'Carl Sagan' },
        { q: 'we are MADE of star-stuff.', a: 'C. Sagan' }
      ],
      () => 0
    )
    expect(pool).toHaveLength(1)
  })

  it('trims surrounding whitespace', () => {
    const pool = normalizePool([{ q: '  Spaced.  ', a: '  Author  ' }], () => 0)
    expect(pool[0]).toEqual({ q: 'Spaced.', a: 'Author' })
  })

  it('shuffles using the injected random source', () => {
    const rows = [
      { q: 'A.', a: 'x' },
      { q: 'B.', a: 'x' },
      { q: 'C.', a: 'x' }
    ]
    // Always picking index 0 reverses the array under Fisher-Yates.
    expect(normalizePool(rows, () => 0).map(p => p.q)).toEqual([
      'C.',
      'A.',
      'B.'
    ])
  })
})

describe('FALLBACK_QUOTES', () => {
  it('ships enough quotes to cover a long wait without repeating', () => {
    expect(FALLBACK_QUOTES.length).toBeGreaterThanOrEqual(20)
  })

  it('every bundled quote survives its own validation', () => {
    for (const q of FALLBACK_QUOTES) expect(acceptQuote(q)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/quotes/__tests__/quote-pool.test.ts`
Expected: FAIL — cannot resolve `../quote-pool`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/quotes/quote-pool.ts`:

```ts
import type { Quote } from './types'

/**
 * A row is usable if it has both text and attribution. There is deliberately
 * NO length filter: the timing function adapts its cadence for long quotes, so
 * an 80-word entry is as valid as a two-word one.
 */
export function acceptQuote(row: unknown): row is Quote {
  if (!row || typeof row !== 'object') return false
  const { q, a } = row as { q?: unknown; a?: unknown }
  return (
    typeof q === 'string' &&
    q.trim().length > 0 &&
    typeof a === 'string' &&
    a.trim().length > 0
  )
}

/**
 * Validate, trim, dedupe and shuffle. Shuffled here (once, server-side) so the
 * client can simply walk the batch in order without repeating itself.
 */
export function normalizePool(
  rows: unknown[],
  random: () => number = Math.random
): Quote[] {
  const seen = new Set<string>()
  const out: Quote[] = []

  for (const row of rows) {
    if (!acceptQuote(row)) continue
    const q = row.q.trim()
    const key = q.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ q, a: row.a.trim() })
  }

  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
```

Create `lib/quotes/fallback-quotes.ts`:

```ts
import type { Quote } from './types'

/**
 * Shipped in-repo so the waiting indicator still has something to show when
 * Couchbase and Redis are both unavailable. Kept deliberately short — this is
 * a safety net, not the real library.
 */
export const FALLBACK_QUOTES: Quote[] = [
  { q: 'We are made of star-stuff.', a: 'Carl Sagan' },
  {
    q: 'Somewhere, something incredible is waiting to be known.',
    a: 'Carl Sagan'
  },
  {
    q: 'The universe is under no obligation to make sense to you.',
    a: 'Neil deGrasse Tyson'
  },
  {
    q: 'Any sufficiently advanced technology is indistinguishable from magic.',
    a: 'Arthur C. Clarke'
  },
  {
    q: 'I have no special talent. I am only passionately curious.',
    a: 'Albert Einstein'
  },
  {
    q: 'Science gathers knowledge faster than society gathers wisdom.',
    a: 'Isaac Asimov'
  },
  {
    q: 'The good thing about science is that it is true whether or not you believe in it.',
    a: 'Neil deGrasse Tyson'
  },
  {
    q: 'Nothing in life is to be feared, it is only to be understood.',
    a: 'Marie Curie'
  },
  {
    q: 'The important thing is not to stop questioning.',
    a: 'Albert Einstein'
  },
  {
    q: 'Equipped with his five senses, man explores the universe around him.',
    a: 'Edwin Hubble'
  },
  {
    q: 'Research is what I am doing when I do not know what I am doing.',
    a: 'Wernher von Braun'
  },
  {
    q: 'If I have seen further it is by standing on the shoulders of giants.',
    a: 'Isaac Newton'
  },
  {
    q: 'What we know is a drop, what we do not know is an ocean.',
    a: 'Isaac Newton'
  },
  { q: 'Simplicity is the ultimate sophistication.', a: 'Leonardo da Vinci' },
  {
    q: 'The cure for boredom is curiosity. There is no cure for curiosity.',
    a: 'Dorothy Parker'
  },
  {
    q: 'Everything should be made as simple as possible, but not simpler.',
    a: 'Albert Einstein'
  },
  {
    q: 'An expert is a person who has made all the mistakes in a narrow field.',
    a: 'Niels Bohr'
  },
  { q: 'Somewhere, something incredible is being ignored.', a: 'Anonymous' },
  { q: 'The best way to predict the future is to invent it.', a: 'Alan Kay' },
  { q: 'Premature optimization is the root of all evil.', a: 'Donald Knuth' },
  { q: 'Any fool can know. The point is to understand.', a: 'Albert Einstein' },
  { q: 'Truth is ever to be found in simplicity.', a: 'Isaac Newton' }
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/quotes/__tests__/quote-pool.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Format, typecheck, commit**

```bash
bunx prettier --write lib/quotes/quote-pool.ts lib/quotes/fallback-quotes.ts lib/quotes/__tests__/quote-pool.test.ts
bun typecheck
git add lib/quotes/quote-pool.ts lib/quotes/fallback-quotes.ts lib/quotes/__tests__/quote-pool.test.ts
git commit -m "Add quote pool normalisation and bundled fallback set"
```

---

### Task 3: Couchbase source

**Files:**

- Create: `lib/quotes/couchbase-quotes.ts`
- Test: `lib/quotes/__tests__/couchbase-quotes.test.ts`
- Modify: `package.json` (add the `couchbase` dependency)

**Interfaces:**

- Consumes: `Quote` from `lib/quotes/types.ts`.
- Produces: `fetchQuotesFromCouchbase(): Promise<Quote[]>` — returns raw rows straight from the document; returns `[]` on any failure and never throws.

- [ ] **Step 1: Add the dependency**

The SDK is native, but Ask's image is `node:22-slim` (Debian/glibc) and couchbase 4.x ships prebuilt glibc binaries, so no build toolchain is needed.

```bash
bun add couchbase@^4.4.5
```

- [ ] **Step 2: Write the failing test**

Create `lib/quotes/__tests__/couchbase-quotes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('couchbase', () => ({ connect: vi.fn() }))

import { connect } from 'couchbase'

import { fetchQuotesFromCouchbase } from '../couchbase-quotes'

const ENV_KEYS = [
  'COUCHBASE_URL',
  'COUCHBASE_USERNAME',
  'COUCHBASE_PASSWORD',
  'COUCHBASE_QUOTES_BUCKET',
  'COUCHBASE_QUOTES_DOC'
] as const

function setEnv() {
  process.env.COUCHBASE_URL = 'cb.example'
  process.env.COUCHBASE_USERNAME = 'user'
  process.env.COUCHBASE_PASSWORD = 'pass'
}

function clusterReturning(content: unknown) {
  return {
    bucket: () => ({
      defaultCollection: () => ({ get: async () => ({ content }) })
    })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('fetchQuotesFromCouchbase', () => {
  it('returns the quotes array from the document', async () => {
    setEnv()
    vi.mocked(connect).mockResolvedValue(
      clusterReturning({ quotes: [{ q: 'One.', a: 'A' }] }) as never
    )

    await expect(fetchQuotesFromCouchbase()).resolves.toEqual([
      { q: 'One.', a: 'A' }
    ])
  })

  it('returns empty without connecting when credentials are absent', async () => {
    await expect(fetchQuotesFromCouchbase()).resolves.toEqual([])
    expect(connect).not.toHaveBeenCalled()
  })

  it('returns empty when the cluster is unreachable, and does not throw', async () => {
    setEnv()
    vi.mocked(connect).mockRejectedValue(new Error('unreachable'))
    await expect(fetchQuotesFromCouchbase()).resolves.toEqual([])
  })

  it('returns empty when the document has an unexpected shape', async () => {
    setEnv()
    vi.mocked(connect).mockResolvedValue(
      clusterReturning({ nope: true }) as never
    )
    await expect(fetchQuotesFromCouchbase()).resolves.toEqual([])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test lib/quotes/__tests__/couchbase-quotes.test.ts`
Expected: FAIL — cannot resolve `../couchbase-quotes`.

- [ ] **Step 4: Write minimal implementation**

Create `lib/quotes/couchbase-quotes.ts`:

```ts
import 'server-only'

import { connect, type Cluster } from 'couchbase'

import type { Quote } from './types'

// Server-side only. Credentials never reach the browser — the route handler is
// the middle server, the same shape hbqnexus uses.
//
// Unlike hbqnexus this holds ONE connection for the process lifetime rather
// than opening and closing per request; the pool is fetched at most once a day
// and cached in Redis, so a waiting user never triggers a round-trip here.

let clusterPromise: Promise<Cluster> | null = null

function getCluster(
  url: string,
  username: string,
  password: string
): Promise<Cluster> {
  if (!clusterPromise) {
    clusterPromise = connect(`couchbase://${url}`, {
      username,
      password
    }).catch(error => {
      clusterPromise = null // let the next call retry rather than caching a failure
      throw error
    })
  }
  return clusterPromise
}

/**
 * Read the quotes document. Returns raw rows for `normalizePool` to validate.
 * Never throws: any failure yields an empty array so the caller falls through
 * to its next source.
 */
export async function fetchQuotesFromCouchbase(): Promise<Quote[]> {
  const url = process.env.COUCHBASE_URL
  const username = process.env.COUCHBASE_USERNAME
  const password = process.env.COUCHBASE_PASSWORD
  if (!url || !username || !password) return []

  const bucketName = process.env.COUCHBASE_QUOTES_BUCKET || 'Quotes'
  const docId = process.env.COUCHBASE_QUOTES_DOC || 'quotes_collection'

  try {
    const cluster = await getCluster(url, username, password)
    const collection = cluster.bucket(bucketName).defaultCollection()
    const result = await collection.get(docId)
    const quotes = (result?.content as { quotes?: unknown })?.quotes
    return Array.isArray(quotes) ? (quotes as Quote[]) : []
  } catch (error) {
    console.warn('[quotes] Couchbase unavailable, falling back:', error)
    return []
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test lib/quotes/__tests__/couchbase-quotes.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Format, typecheck, commit**

```bash
bunx prettier --write lib/quotes/couchbase-quotes.ts lib/quotes/__tests__/couchbase-quotes.test.ts
bun typecheck
git add package.json bun.lock lib/quotes/couchbase-quotes.ts lib/quotes/__tests__/couchbase-quotes.test.ts
git commit -m "Add server-only Couchbase quote source that never throws"
```

---

### Task 4: Cached batch endpoint

**Files:**

- Create: `app/api/quotes/route.ts`
- Test: `app/api/quotes/__tests__/route.test.ts`

**Interfaces:**

- Consumes: `fetchQuotesFromCouchbase()`, `normalizePool()`, `FALLBACK_QUOTES`, `getLatencyRedis()` from `lib/telemetry/latency-store.ts` (an existing lazily-connected client returning `null` when Redis is unavailable).
- Produces: `GET /api/quotes?n=<count>` → `{ quotes: Quote[] }`.

Note: `getLatencyRedis()` resolves to a client typed with optional `lPush`/`lpush` methods. For this route use `get`/`set`, which both dialects expose; guard with `typeof client.get === 'function'`.

- [ ] **Step 1: Write the failing test**

Create `app/api/quotes/__tests__/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/quotes/couchbase-quotes')
vi.mock('@/lib/telemetry/latency-store')

import { fetchQuotesFromCouchbase } from '@/lib/quotes/couchbase-quotes'
import { getLatencyRedis } from '@/lib/telemetry/latency-store'

import { GET } from '../route'

function request(url = 'http://localhost:3000/api/quotes') {
  return new Request(url)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getLatencyRedis).mockResolvedValue(null as never)
  vi.mocked(fetchQuotesFromCouchbase).mockResolvedValue([])
})

describe('GET /api/quotes', () => {
  it('serves the bundled fallback when Couchbase and Redis are both unavailable', async () => {
    const res = await GET(request())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.quotes.length).toBeGreaterThan(0)
    expect(typeof body.quotes[0].q).toBe('string')
    expect(typeof body.quotes[0].a).toBe('string')
  })

  it('serves the cached pool without touching Couchbase when Redis has one', async () => {
    vi.mocked(getLatencyRedis).mockResolvedValue({
      get: async () => JSON.stringify([{ q: 'Cached.', a: 'Redis' }]),
      set: async () => undefined
    } as never)

    const res = await GET(request())
    const body = await res.json()

    expect(body.quotes).toEqual([{ q: 'Cached.', a: 'Redis' }])
    expect(fetchQuotesFromCouchbase).not.toHaveBeenCalled()
  })

  it('fetches and caches when Redis is empty', async () => {
    const set = vi.fn(async () => undefined)
    vi.mocked(getLatencyRedis).mockResolvedValue({
      get: async () => null,
      set
    } as never)
    vi.mocked(fetchQuotesFromCouchbase).mockResolvedValue([
      { q: 'Fresh.', a: 'Couchbase' }
    ])

    const res = await GET(request())
    const body = await res.json()

    expect(body.quotes).toEqual([{ q: 'Fresh.', a: 'Couchbase' }])
    expect(set).toHaveBeenCalled()
  })

  it('caps the batch size so a caller cannot ask for the whole pool', async () => {
    const res = await GET(request('http://localhost:3000/api/quotes?n=9999'))
    const body = await res.json()
    expect(body.quotes.length).toBeLessThanOrEqual(100)
  })

  it('never 500s, even when Redis itself throws', async () => {
    vi.mocked(getLatencyRedis).mockRejectedValue(new Error('redis down'))
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect((await res.json()).quotes.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test app/api/quotes/__tests__/route.test.ts`
Expected: FAIL — cannot resolve `../route`.

- [ ] **Step 3: Write minimal implementation**

Create `app/api/quotes/route.ts`:

```ts
import { NextResponse } from 'next/server'

import { fetchQuotesFromCouchbase } from '@/lib/quotes/couchbase-quotes'
import { FALLBACK_QUOTES } from '@/lib/quotes/fallback-quotes'
import { normalizePool } from '@/lib/quotes/quote-pool'
import type { Quote } from '@/lib/quotes/types'
import { getLatencyRedis } from '@/lib/telemetry/latency-store'

// The middle server for quotes: Couchbase credentials live here and never
// reach the browser. The client fetches ONE batch per page session and cycles
// it locally, so no request is made while the user is actually waiting.

const CACHE_KEY = 'quotes:pool'
const CACHE_TTL_SECONDS = 60 * 60 * 24
const DEFAULT_BATCH = 40
const MAX_BATCH = 100

type CacheClient = {
  get?: (key: string) => Promise<unknown>
  set?: (key: string, value: string, opts?: unknown) => Promise<unknown>
}

async function readCache(client: CacheClient): Promise<Quote[] | null> {
  if (typeof client.get !== 'function') return null
  const raw = await client.get(CACHE_KEY)
  if (typeof raw !== 'string' || !raw) return null
  const parsed: unknown = JSON.parse(raw)
  return Array.isArray(parsed) && parsed.length ? (parsed as Quote[]) : null
}

async function writeCache(client: CacheClient, pool: Quote[]): Promise<void> {
  if (typeof client.set !== 'function') return
  const payload = JSON.stringify(pool)
  // node-redis takes { EX }, Upstash takes { ex }; send both, each ignores the other.
  await client.set(CACHE_KEY, payload, {
    EX: CACHE_TTL_SECONDS,
    ex: CACHE_TTL_SECONDS
  })
}

/** Resolve the pool through the degradation chain: Redis → Couchbase → bundled. */
async function loadPool(): Promise<Quote[]> {
  let client: CacheClient | null = null
  try {
    client = (await getLatencyRedis()) as CacheClient | null
    if (client) {
      const cached = await readCache(client)
      if (cached) return cached
    }
  } catch (error) {
    console.warn('[quotes] cache read failed:', error)
  }

  const fresh = normalizePool(await fetchQuotesFromCouchbase())
  if (!fresh.length) return FALLBACK_QUOTES

  try {
    if (client) await writeCache(client, fresh)
  } catch (error) {
    console.warn('[quotes] cache write failed:', error)
  }
  return fresh
}

export async function GET(request: Request): Promise<NextResponse> {
  let pool: Quote[]
  try {
    pool = await loadPool()
  } catch (error) {
    // The quote is decoration; a failure must degrade, never surface.
    console.warn('[quotes] falling back to bundled set:', error)
    pool = FALLBACK_QUOTES
  }

  const requested = Number(new URL(request.url).searchParams.get('n'))
  const n =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_BATCH)
      : DEFAULT_BATCH

  const start = Math.floor(Math.random() * Math.max(1, pool.length))
  const quotes = Array.from(
    { length: Math.min(n, pool.length) },
    (_, i) => pool[(start + i) % pool.length]
  )

  return NextResponse.json({ quotes })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test app/api/quotes/__tests__/route.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Format, typecheck, commit**

```bash
bunx prettier --write app/api/quotes/route.ts app/api/quotes/__tests__/route.test.ts
bun typecheck
git add app/api/quotes
git commit -m "Add /api/quotes: Redis-cached batch with Couchbase and bundled fallbacks"
```

---

### Task 5: Waiting quote component

**Files:**

- Create: `components/waiting-quote.tsx`
- Modify: `app/globals.css` (append after the existing `.wb-rail` block, around line 590)
- Test: `components/__tests__/waiting-quote.test.tsx`

**Interfaces:**

- Consumes: `quoteTiming`, `QUOTE_FADE_OUT_MS`, `QUOTE_AUTHOR_DELAY_MS` from `lib/quotes/quote-timing.ts`; `FALLBACK_QUOTES`; `Quote`.
- Produces: `<WaitingQuote />` — a client component taking no props.

- [ ] **Step 1: Add the reveal styles**

Append to `app/globals.css`:

```css
/* Waiting-indicator quote: five reveals, one chosen at random per quote.
   Each word carries its own animation-delay, set inline from the timing
   function so the cadence adapts to quote length. */
.wq-word {
  display: inline-block;
  white-space: pre;
  will-change: transform, opacity, filter;
}

.wq-rise .wq-word {
  animation: wq-rise 520ms cubic-bezier(0.2, 0.8, 0.3, 1) both;
}
.wq-focus .wq-word {
  animation: wq-focus 560ms ease-out both;
}
.wq-drift .wq-word {
  animation: wq-drift 520ms cubic-bezier(0.2, 0.8, 0.3, 1) both;
}
.wq-settle .wq-word {
  animation: wq-settle 460ms cubic-bezier(0.34, 1.4, 0.5, 1) both;
}
.wq-wipe .wq-word {
  animation: wq-wipe 560ms cubic-bezier(0.3, 0.7, 0.2, 1) both;
}

@keyframes wq-rise {
  from {
    opacity: 0;
    transform: translateY(9px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes wq-focus {
  from {
    opacity: 0;
    filter: blur(7px);
  }
  to {
    opacity: 1;
    filter: blur(0);
  }
}
@keyframes wq-drift {
  from {
    opacity: 0;
    transform: translateX(-12px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes wq-settle {
  from {
    opacity: 0;
    transform: scale(0.86);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
@keyframes wq-wipe {
  from {
    opacity: 0.15;
    clip-path: inset(0 100% 0 0);
  }
  to {
    opacity: 1;
    clip-path: inset(0 0 0 0);
  }
}

.wq-leaving {
  animation: wq-leave 420ms ease-in forwards;
}
@keyframes wq-leave {
  to {
    opacity: 0;
    transform: translateY(-5px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .wq-word,
  .wq-leaving {
    animation: none !important;
    opacity: 1 !important;
    filter: none !important;
    transform: none !important;
    clip-path: none !important;
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `components/__tests__/waiting-quote.test.tsx`:

```tsx
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WaitingQuote } from '../waiting-quote'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        quotes: [{ q: 'We are made of star-stuff.', a: 'Carl Sagan' }]
      })
    }))
  )
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('WaitingQuote', () => {
  it('renders one span per word so each can animate independently', async () => {
    const { container } = render(<WaitingQuote />)
    await vi.advanceTimersByTimeAsync(0)

    const words = container.querySelectorAll('.wq-word')
    // five words plus the attribution
    expect(words.length).toBeGreaterThanOrEqual(6)
  })

  it('staggers each word by the cadence from the timing function', async () => {
    const { container } = render(<WaitingQuote />)
    await vi.advanceTimersByTimeAsync(0)

    const words = Array.from(
      container.querySelectorAll<HTMLElement>('.wq-word')
    )
    expect(words[0].style.animationDelay).toBe('0ms')
    expect(words[1].style.animationDelay).toBe('300ms')
  })

  it('shows an elapsed timer that ticks', async () => {
    render(<WaitingQuote />)
    await vi.advanceTimersByTimeAsync(0)
    expect(screen.getByTestId('waiting-elapsed').textContent).toBe('0:00')

    await vi.advanceTimersByTimeAsync(62_000)
    expect(screen.getByTestId('waiting-elapsed').textContent).toBe('1:02')
  })

  it('stops all timers on unmount', async () => {
    const { unmount } = render(<WaitingQuote />)
    await vi.advanceTimersByTimeAsync(0)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test components/__tests__/waiting-quote.test.tsx`
Expected: FAIL — cannot resolve `../waiting-quote`.

- [ ] **Step 4: Write minimal implementation**

Create `components/waiting-quote.tsx`:

```tsx
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { FALLBACK_QUOTES } from '@/lib/quotes/fallback-quotes'
import {
  QUOTE_AUTHOR_DELAY_MS,
  QUOTE_FADE_OUT_MS,
  quoteTiming
} from '@/lib/quotes/quote-timing'
import type { Quote } from '@/lib/quotes/types'

const STYLES = [
  'wq-rise',
  'wq-focus',
  'wq-drift',
  'wq-settle',
  'wq-wipe'
] as const
const BATCH_SIZE = 40

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Ambient reading material for long waits: an elapsed timer plus a quote that
 * reveals a word at a time, changing animation with every quote.
 *
 * One batch is fetched per mount and cycled locally — nothing hits the network
 * while the user is actually waiting.
 */
export function WaitingQuote() {
  const [pool, setPool] = useState<Quote[]>(FALLBACK_QUOTES)
  const [index, setIndex] = useState(0)
  const [styleClass, setStyleClass] = useState<string>(STYLES[0])
  const [leaving, setLeaving] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const previousStyle = useRef<string>('')

  // One batch per mount.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/quotes?n=${BATCH_SIZE}`)
      .then(res => (res.ok ? res.json() : null))
      .then((data: { quotes?: Quote[] } | null) => {
        if (cancelled || !data?.quotes?.length) return
        setPool(data.quotes)
        setIndex(0)
      })
      .catch(() => {
        // Keep the bundled set — a quote is decoration, not a failure worth showing.
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const id = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const quote = pool[index % pool.length]
  const timing = useMemo(() => quoteTiming(quote?.q ?? ''), [quote])

  // Pick a style that is not the one just used, then schedule the changeover.
  useEffect(() => {
    if (!quote) return
    const choices = STYLES.filter(s => s !== previousStyle.current)
    const next = choices[Math.floor(Math.random() * choices.length)]
    previousStyle.current = next
    setStyleClass(next)
    setLeaving(false)

    const fadeAt = Math.max(0, timing.totalMs - QUOTE_FADE_OUT_MS)
    const fadeId = setTimeout(() => setLeaving(true), fadeAt)
    const nextId = setTimeout(() => setIndex(i => i + 1), timing.totalMs)
    return () => {
      clearTimeout(fadeId)
      clearTimeout(nextId)
    }
  }, [quote, timing.totalMs])

  if (!quote) return null

  const tokens = quote.q.split(/(\s+)/).filter(Boolean)
  let wordIndex = 0

  return (
    <div className="mt-2 flex flex-col gap-1">
      <div
        className={`text-sm italic text-muted-foreground/80 ${styleClass} ${leaving ? 'wq-leaving' : ''}`}
        aria-live="polite"
      >
        {tokens.map((token, i) => {
          const delay = wordIndex * timing.perWordMs
          if (/\S/.test(token)) wordIndex++
          return (
            <span
              key={`${index}-${i}`}
              className="wq-word"
              style={{ animationDelay: `${delay}ms` }}
            >
              {token}
            </span>
          )
        })}
        <span
          className="wq-word not-italic text-xs text-muted-foreground/60"
          style={{
            animationDelay: `${wordIndex * timing.perWordMs + QUOTE_AUTHOR_DELAY_MS}ms`
          }}
        >
          {`  — ${quote.a}`}
        </span>
      </div>
      <span
        data-testid="waiting-elapsed"
        aria-hidden="true"
        className="font-mono text-xs tabular-nums text-muted-foreground/50"
      >
        {formatElapsed(elapsed)}
      </span>
    </div>
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test components/__tests__/waiting-quote.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 6: Format, typecheck, commit**

```bash
bunx prettier --write components/waiting-quote.tsx components/__tests__/waiting-quote.test.tsx app/globals.css
bun typecheck
git add components/waiting-quote.tsx components/__tests__/waiting-quote.test.tsx app/globals.css
git commit -m "Add waiting-quote component: word reveal, style rotation, elapsed timer"
```

---

### Task 6: Wire into the indicator

**Files:**

- Modify: `components/research-process-section.tsx` (the in-progress branch, around lines 476–508)

**Interfaces:**

- Consumes: `<WaitingQuote />` from `components/waiting-quote.tsx`.
- Produces: nothing.

- [ ] **Step 1: Read the target block**

Run: `sed -n '470,512p' components/research-process-section.tsx`

You are looking for the `{isInProgress && (` block containing the `<button>` that renders `<WildBreathGlyph className="size-6 shrink-0" spin />` and the `<span className="wb-rail" />`. That button and its behaviour must not change.

- [ ] **Step 2: Add the import**

Add alongside the other local component imports (keep them alphabetically sorted — ESLint enforces this and `bun lint --fix` will reorder if wrong):

```tsx
import { WaitingQuote } from './waiting-quote'
```

- [ ] **Step 3: Render the quote under the indicator row**

The existing structure is:

```tsx
<div className="flex items-center gap-1">
  {isInProgress && (
    <button ...>...</button>
  )}
  {summaryVisible && (
    <CollapsibleTrigger asChild>...</CollapsibleTrigger>
  )}
</div>
```

Wrap that row so the quote sits beneath it, changing only the nesting:

```tsx
<div className="flex flex-col">
  <div className="flex items-center gap-1">
    {isInProgress && (
      <button ...>...</button>
    )}
    {summaryVisible && (
      <CollapsibleTrigger asChild>...</CollapsibleTrigger>
    )}
  </div>
  {isInProgress && <WaitingQuote />}
</div>
```

Leave the `<button>` and `<CollapsibleTrigger>` contents exactly as they are.

- [ ] **Step 4: Verify the whole suite still passes**

```bash
bun run test
bun typecheck
bun lint
```

Expected: all tests pass, no type errors, no new lint errors (4 pre-existing warnings in `action-buttons.tsx` and `news-article-widget.tsx` are expected and unrelated).

- [ ] **Step 5: Commit**

```bash
bunx prettier --write components/research-process-section.tsx
git add components/research-process-section.tsx
git commit -m "Show the waiting quote under the in-progress indicator"
```

---

## Self-Review

**Spec coverage:** timing model → Task 1; pool rules (no length cap, dedupe) → Task 2; bundled fallback → Task 2; Couchbase via native SDK, server-only, never throws → Task 3; Redis cache, batch endpoint, degradation chain → Task 4; reveal styles, timer, reduced motion, a11y, unmount cleanup → Task 5; integration → Task 6. Env vars are documented in the spec and read in Task 3.

**Type consistency:** `Quote` is defined once in Task 1 and imported everywhere. `quoteTiming` returns `perWordMs`/`totalMs`, used under those names in Task 5. `fetchQuotesFromCouchbase` and `normalizePool` signatures match their Task 4 call sites.

**Known deviations from spec, deliberate:** the spec lists `lib/quotes/types.ts` implicitly; it is created explicitly in Task 1 so the `Quote` type has one home.
