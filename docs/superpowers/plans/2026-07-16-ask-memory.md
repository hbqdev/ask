# Ask Memory (A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Ask per-user, cross-session memory — auto-extracted durable facts/preferences stored in pgvector, retrieved into the researcher — the ChatGPT/Claude/Perplexity "it remembers me" experience.

**Architecture:** A `user_memories` pgvector table (RLS-isolated like `chats`). After each turn, an async granite pass extracts candidate facts; a write path dedups by embedding similarity, graduates candidates to `confirmed` on repetition, and supersedes contradictions. A `remember` tool handles explicit saves. Confirmed memories inject into the researcher's system prompt. A minimal daily consolidation sweep keeps the set coherent. Everything fails safe and is inert when disabled.

**Tech Stack:** Next.js 16 / TS, PostgreSQL 17 + **pgvector** + Drizzle, local embeddings (mxbai, 1024-d, transformers.js), granite4.1:8b on serenity, Vitest.

## Global Constraints

- **RLS-isolated per user** exactly like `chats`: policy `user_id = (select current_setting('app.current_user_id', true))`; all user-scoped DB access goes through `withOptionalRLS(userId, tx => …)` (`lib/db/with-rls.ts`).
- **Fail-safe / non-blocking:** extraction + consolidation run async and NEVER block a response or throw into the turn. Injection failure ⇒ no memories, turn proceeds. serenity/granite down ⇒ extraction no-ops (mirror `classifyQuery`'s fallback).
- **Inert when disabled:** `MEMORY_ENABLED` env (only `'off'` disables) is the global switch; per-user `user_settings.memory_enabled` gates each user. Disabled ⇒ no extraction, no `remember` tool, no injection.
- **Only `confirmed` memories are injected.** Candidates graduate to `confirmed` after `MEMORY_GRADUATE_SIGHTINGS` (default 2) sightings; `remember`-tool saves insert directly as `confirmed`.
- **Embeddings** use the configured `EMBEDDING_MODEL` (mxbai, **1024-d**); the vector column dimension is pinned to 1024. Reuse `embedTexts` from `lib/embeddings/transformers-embedding.ts`.
- **Env defaults (exact):** `MEMORY_ENABLED` on; `MEMORY_SIM_THRESHOLD` 0.90; `MEMORY_GRADUATE_SIGHTINGS` 2; `MEMORY_MAX_PER_USER` 30; `MEMORY_INJECT_TOP_K` 30.
- **Testing:** `bun run test` (NOT `bun test`). Pre-commit: `bun lint --fix`, `bun typecheck`, and `npx prettier --write <only touched files>` (NOT `bun format` — it reformats the whole repo). Branch has pre-existing typecheck/lint issues in UNRELATED files — add no new ones in touched files. Commit on `admin-feature`; do NOT push/redeploy until final verification.

---

## File Structure

- **Modify** `docker-compose.yaml` — Postgres image → `pgvector/pgvector:pg17`.
- **Modify** `lib/db/schema.ts` — add `userMemories` + `userSettings` tables (RLS, vector column, HNSW index).
- **Create** `drizzle/NNNN_*.sql` (generated) — add `CREATE EXTENSION IF NOT EXISTS vector;`.
- **Create** `lib/memory/types.ts` — shared types (`MemoryCandidate`, `MemoryRow`).
- **Create** `lib/memory/write.ts` — pure write-path decision logic (dedup/graduate/supersede) + the DB write orchestration via `withOptionalRLS`.
- **Create** `lib/db/memory-actions.ts` — RLS DB ops: nearest-by-cosine, insert, bump-sightings, supersede, evict, list, delete, getConfirmed, setLastUsed, get/set toggle.
- **Create** `lib/agents/memory-extractor.ts` — granite extraction pass (mirrors `query-classifier.ts`).
- **Create** `lib/agents/memory-consolidator.ts` — minimal periodic merge/evict.
- **Create** `lib/tools/remember.ts` — the `remember` tool.
- **Create** `app/api/memory/consolidate/route.ts` — cron trigger for consolidation.
- **Modify** `lib/agents/researcher.ts` — accept `userId`; inject confirmed memories into the system prompt; add `remember` to the toolset. `lib/types/agent.ts` — add `remember` to `ResearcherTools`.
- **Modify** `lib/streaming/create-chat-stream-response.ts` (+ ephemeral variant) — pass `userId` to the researcher; kick off async extraction in `onFinish`.
- **Create** memory settings UI: `app/settings/memory/page.tsx` + `components/memory/*` + server actions in `lib/actions/memory.ts`.
- **Modify** `.env.local.example` — document memory env vars.

---

## Task 1: pgvector infra + schema + migration

**Files:**
- Modify: `docker-compose.yaml`
- Modify: `lib/db/schema.ts`
- Generate: `drizzle/NNNN_*.sql` (edited to add the extension)
- Test: `lib/db/__tests__/memory-schema.test.ts`

**Interfaces:**
- Produces: Drizzle tables `userMemories`, `userSettings`; types `UserMemory`, `UserSettings`.

- [ ] **Step 1: Swap the Postgres image to pgvector**

In `docker-compose.yaml`, change the `postgres` service image to `pgvector/pgvector:pg17` (drop-in superset of `postgres:17` with the `vector` extension available). Keep all env/volumes unchanged.

- [ ] **Step 2: Add the tables to `lib/db/schema.ts`**

Add the `vector` import to the `drizzle-orm/pg-core` import list, then append:

```typescript
// User long-term memory (feature A). Only `confirmed` rows are injected;
// `candidate` rows accumulate `sightings` until they graduate. RLS-isolated
// per user exactly like `chats`.
export const userMemories = pgTable(
  'user_memories',
  {
    id: varchar('id', { length: ID_LENGTH })
      .primaryKey()
      .$defaultFn(() => generateId()),
    userId: varchar('user_id', { length: USER_ID_LENGTH }).notNull(),
    content: text('content').notNull(),
    category: varchar('category', {
      length: VARCHAR_LENGTH,
      enum: ['preference', 'fact', 'interest']
    }).notNull(),
    status: varchar('status', {
      length: VARCHAR_LENGTH,
      enum: ['candidate', 'confirmed']
    })
      .notNull()
      .default('candidate'),
    sightings: integer('sightings').notNull().default(1),
    embedding: vector('embedding', { dimensions: 1024 }).notNull(),
    sourceChatId: varchar('source_chat_id', { length: ID_LENGTH }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at')
  },
  table => [
    index('user_memories_user_id_idx').on(table.userId),
    index('user_memories_user_id_status_idx').on(table.userId, table.status),
    index('user_memories_embedding_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops')
    ),
    pgPolicy('users_manage_own_memories', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: sql`user_id = (select current_setting('app.current_user_id', true))`,
      withCheck: sql`user_id = (select current_setting('app.current_user_id', true))`
    })
  ]
).enableRLS()

export type UserMemory = InferSelectModel<typeof userMemories>

// Per-user settings (currently just the memory on/off toggle).
export const userSettings = pgTable(
  'user_settings',
  {
    userId: varchar('user_id', { length: USER_ID_LENGTH }).primaryKey(),
    memoryEnabled: boolean('memory_enabled').notNull().default(true),
    updatedAt: timestamp('updated_at').notNull().defaultNow()
  },
  table => [
    pgPolicy('users_manage_own_settings', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: sql`user_id = (select current_setting('app.current_user_id', true))`,
      withCheck: sql`user_id = (select current_setting('app.current_user_id', true))`
    })
  ]
).enableRLS()

export type UserSettings = InferSelectModel<typeof userSettings>
```

Add `boolean` and `vector` to the `drizzle-orm/pg-core` import block (alongside the existing `integer`, `varchar`, etc.).

- [ ] **Step 3: Generate the migration and add the extension**

Run: `bunx drizzle-kit generate` — produces `drizzle/NNNN_<name>.sql`. Open that file and add, as the **first** statement (before any table/index creation):

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

(The HNSW index and `vector` column require the extension to exist first.)

- [ ] **Step 4: Write a schema-shape test**

Create `lib/db/__tests__/memory-schema.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import { userMemories, userSettings } from '../schema'

describe('memory schema', () => {
  it('userMemories has the memory columns', () => {
    const cols = Object.keys(userMemories)
    for (const c of [
      'id',
      'userId',
      'content',
      'category',
      'status',
      'sightings',
      'embedding',
      'sourceChatId',
      'lastUsedAt'
    ]) {
      expect(cols).toContain(c)
    }
  })

  it('userSettings has memoryEnabled', () => {
    expect(Object.keys(userSettings)).toContain('memoryEnabled')
  })
})
```

- [ ] **Step 5: Run test, migrate locally, verify**

Run: `bun run test lib/db/__tests__/memory-schema.test.ts` → PASS. Then bring up the pgvector image and migrate: `docker compose up -d postgres && bun migrate` → migration applies cleanly (extension + tables created). Verify with `docker exec ask-postgres psql -U morphic -d morphic -c "\d user_memories"` shows the `vector` column.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd /home/nightfury/selfhosted/ask
bun lint --fix && bun typecheck && npx prettier --write lib/db/schema.ts lib/db/__tests__/memory-schema.test.ts docker-compose.yaml
git add docker-compose.yaml lib/db/schema.ts drizzle/ lib/db/__tests__/memory-schema.test.ts
git commit -m "feat(memory): pgvector user_memories + user_settings schema and migration"
```

---

## Task 2: Memory write-path logic + DB actions

**Files:**
- Create: `lib/memory/types.ts`
- Create: `lib/memory/write.ts`
- Create: `lib/db/memory-actions.ts`
- Test: `lib/memory/__tests__/write.test.ts`

**Interfaces:**
- Consumes: `withOptionalRLS` (`lib/db/with-rls.ts`), `embedTexts` (`lib/embeddings/transformers-embedding.ts`), `userMemories`/`userSettings` (Task 1).
- Produces: `decideWrite(candidate, nearest, cfg): WriteDecision` (pure); `saveMemory(userId, candidate, opts)`; `getConfirmedMemories(userId, limit)`; `listMemories(userId)`; `deleteMemory(userId, id)`; `clearMemories(userId)`; `setLastUsed(userId, ids)`; `isMemoryEnabled(userId)`; `setMemoryEnabled(userId, on)`.

- [ ] **Step 1: Shared types**

Create `lib/memory/types.ts`:

```typescript
export type MemoryCategory = 'preference' | 'fact' | 'interest'

export interface MemoryCandidate {
  content: string
  category: MemoryCategory
  /** Confirmed immediately (the `remember` tool / explicit user save). */
  confirmed?: boolean
}

export interface NearestMemory {
  id: string
  content: string
  status: 'candidate' | 'confirmed'
  sightings: number
  similarity: number // cosine similarity in [0,1]
}

export type WriteDecision =
  | { action: 'insert'; status: 'candidate' | 'confirmed' }
  | { action: 'bump'; id: string; graduate: boolean }
  | { action: 'supersede'; id: string }
  | { action: 'skip' }

export interface WriteConfig {
  simThreshold: number // MEMORY_SIM_THRESHOLD
  graduateSightings: number // MEMORY_GRADUATE_SIGHTINGS
}
```

- [ ] **Step 2: Write the failing test for `decideWrite`**

Create `lib/memory/__tests__/write.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import { decideWrite } from '../write'
import type { MemoryCandidate, NearestMemory, WriteConfig } from '../types'

const cfg: WriteConfig = { simThreshold: 0.9, graduateSightings: 2 }
const cand = (over: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
  content: 'Self-hosts their infrastructure',
  category: 'fact',
  ...over
})
const near = (over: Partial<NearestMemory> = {}): NearestMemory => ({
  id: 'm1',
  content: 'Self-hosts everything',
  status: 'candidate',
  sightings: 1,
  similarity: 0.95,
  ...over
})

describe('decideWrite', () => {
  it('inserts a new candidate when nothing is similar', () => {
    expect(decideWrite(cand(), null, cfg)).toEqual({
      action: 'insert',
      status: 'candidate'
    })
  })

  it('inserts confirmed directly for a user-directed save', () => {
    expect(decideWrite(cand({ confirmed: true }), null, cfg)).toEqual({
      action: 'insert',
      status: 'confirmed'
    })
  })

  it('bumps + graduates a near-duplicate candidate that reaches the threshold', () => {
    // existing sightings 1 → after bump 2 == graduateSightings → graduate
    expect(decideWrite(cand(), near({ sightings: 1 }), cfg)).toEqual({
      action: 'bump',
      id: 'm1',
      graduate: true
    })
  })

  it('bumps without graduating when still below threshold', () => {
    const c = { ...cfg, graduateSightings: 3 }
    expect(decideWrite(cand(), near({ sightings: 1 }), c)).toEqual({
      action: 'bump',
      id: 'm1',
      graduate: false
    })
  })

  it('does not demote an already-confirmed near-duplicate (bump, no graduate flag effect)', () => {
    expect(
      decideWrite(cand(), near({ status: 'confirmed', sightings: 5 }), cfg)
    ).toEqual({ action: 'bump', id: 'm1', graduate: false })
  })

  it('below the similarity threshold is treated as new, not a dup', () => {
    expect(decideWrite(cand(), near({ similarity: 0.5 }), cfg)).toEqual({
      action: 'insert',
      status: 'candidate'
    })
  })
})
```

- [ ] **Step 3: Run to confirm it fails**

Run: `bun run test lib/memory/__tests__/write.test.ts`
Expected: FAIL — `decideWrite` not found.

- [ ] **Step 4: Implement `decideWrite` + DB actions**

Create `lib/memory/write.ts`:

```typescript
import type {
  MemoryCandidate,
  NearestMemory,
  WriteConfig,
  WriteDecision
} from './types'

/**
 * Pure decision for the write path given a candidate and its nearest existing
 * memory (or null). Contradiction/supersede is decided one layer up (it needs a
 * granite call), so this function handles the mechanical dedup/graduation:
 * - no similar existing → insert (confirmed if the candidate is user-directed)
 * - similar existing → bump sightings; graduate a candidate to confirmed once
 *   its post-bump count reaches graduateSightings.
 */
export function decideWrite(
  candidate: MemoryCandidate,
  nearest: NearestMemory | null,
  cfg: WriteConfig
): WriteDecision {
  if (!nearest || nearest.similarity < cfg.simThreshold) {
    return {
      action: 'insert',
      status: candidate.confirmed ? 'confirmed' : 'candidate'
    }
  }
  // A near-duplicate exists → repetition signal.
  const graduate =
    nearest.status === 'candidate' &&
    (candidate.confirmed || nearest.sightings + 1 >= cfg.graduateSightings)
  return { action: 'bump', id: nearest.id, graduate }
}
```

Create `lib/db/memory-actions.ts` mirroring `lib/db/actions.ts` (all ops through `withOptionalRLS`, using drizzle + pgvector cosine). Key ops:

```typescript
import { and, desc, eq, sql } from 'drizzle-orm'

import { embedTexts, getConfiguredModel } from '@/lib/embeddings/transformers-embedding'

import { userMemories, userSettings } from './schema'
import { withOptionalRLS } from './with-rls'

const toVec = (v: number[]) => sql`${JSON.stringify(v)}::vector`

/** Nearest existing memory to a candidate embedding, by cosine similarity. */
export async function nearestMemory(
  userId: string,
  embedding: number[]
): Promise<{
  id: string
  content: string
  status: 'candidate' | 'confirmed'
  sightings: number
  similarity: number
} | null> {
  return withOptionalRLS(userId, async tx => {
    const rows = await tx
      .select({
        id: userMemories.id,
        content: userMemories.content,
        status: userMemories.status,
        sightings: userMemories.sightings,
        similarity: sql<number>`1 - (${userMemories.embedding} <=> ${toVec(embedding)})`
      })
      .from(userMemories)
      .where(eq(userMemories.userId, userId))
      .orderBy(sql`${userMemories.embedding} <=> ${toVec(embedding)}`)
      .limit(1)
    return rows[0] ?? null
  })
}

export async function insertMemory(
  userId: string,
  m: {
    content: string
    category: string
    status: 'candidate' | 'confirmed'
    embedding: number[]
    sourceChatId?: string
  }
): Promise<void> {
  await withOptionalRLS(userId, async tx => {
    await tx.insert(userMemories).values({
      userId,
      content: m.content,
      category: m.category as any,
      status: m.status,
      embedding: m.embedding,
      sourceChatId: m.sourceChatId ?? null
    })
  })
}

export async function bumpMemory(
  userId: string,
  id: string,
  graduate: boolean
): Promise<void> {
  await withOptionalRLS(userId, async tx => {
    await tx
      .update(userMemories)
      .set({
        sightings: sql`${userMemories.sightings} + 1`,
        status: graduate ? 'confirmed' : undefined,
        updatedAt: new Date()
      })
      .where(and(eq(userMemories.userId, userId), eq(userMemories.id, id)))
  })
}

export async function supersedeMemory(
  userId: string,
  id: string,
  content: string,
  embedding: number[]
): Promise<void> {
  await withOptionalRLS(userId, async tx => {
    await tx
      .update(userMemories)
      .set({ content, embedding, status: 'confirmed', updatedAt: new Date() })
      .where(and(eq(userMemories.userId, userId), eq(userMemories.id, id)))
  })
}

/** Confirmed memories for injection (most-recently-used first), capped. */
export async function getConfirmedMemories(userId: string, limit: number) {
  return withOptionalRLS(userId, async tx =>
    tx
      .select()
      .from(userMemories)
      .where(
        and(eq(userMemories.userId, userId), eq(userMemories.status, 'confirmed'))
      )
      .orderBy(desc(userMemories.lastUsedAt), desc(userMemories.updatedAt))
      .limit(limit)
  )
}

export async function setLastUsed(userId: string, ids: string[]) {
  if (ids.length === 0) return
  await withOptionalRLS(userId, async tx => {
    await tx
      .update(userMemories)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(userMemories.userId, userId),
          sql`${userMemories.id} = ANY(${ids})`
        )
      )
  })
}

/** LRU-evict confirmed memories beyond the cap. */
export async function evictOverCap(userId: string, cap: number) {
  await withOptionalRLS(userId, async tx => {
    await tx.execute(sql`
      DELETE FROM user_memories WHERE id IN (
        SELECT id FROM user_memories
        WHERE user_id = ${userId} AND status = 'confirmed'
        ORDER BY last_used_at ASC NULLS FIRST, updated_at ASC
        OFFSET ${cap}
      )`)
  })
}

export async function listMemories(userId: string) {
  return withOptionalRLS(userId, async tx =>
    tx
      .select()
      .from(userMemories)
      .where(eq(userMemories.userId, userId))
      .orderBy(desc(userMemories.updatedAt))
  )
}

export async function deleteMemory(userId: string, id: string) {
  await withOptionalRLS(userId, async tx => {
    await tx
      .delete(userMemories)
      .where(and(eq(userMemories.userId, userId), eq(userMemories.id, id)))
  })
}

export async function clearMemories(userId: string) {
  await withOptionalRLS(userId, async tx => {
    await tx.delete(userMemories).where(eq(userMemories.userId, userId))
  })
}

export async function isMemoryEnabled(userId: string): Promise<boolean> {
  if (process.env.MEMORY_ENABLED === 'off') return false
  return withOptionalRLS(userId, async tx => {
    const rows = await tx
      .select({ enabled: userSettings.memoryEnabled })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1)
    return rows[0]?.enabled ?? true // default on
  })
}

export async function setMemoryEnabled(userId: string, on: boolean) {
  await withOptionalRLS(userId, async tx => {
    await tx
      .insert(userSettings)
      .values({ userId, memoryEnabled: on })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { memoryEnabled: on, updatedAt: new Date() }
      })
  })
}

export { embedTexts, getConfiguredModel } // re-export for callers' convenience
```

- [ ] **Step 5: Run to confirm `decideWrite` tests pass**

Run: `bun run test lib/memory/__tests__/write.test.ts`
Expected: PASS (6 tests). (The DB actions are integration-covered by the live E2E; the pure decision logic is unit-tested here.)

- [ ] **Step 6: Lint, typecheck, format, commit**

```bash
cd /home/nightfury/selfhosted/ask
bun lint --fix && bun typecheck && npx prettier --write lib/memory/types.ts lib/memory/write.ts lib/db/memory-actions.ts lib/memory/__tests__/write.test.ts
git add lib/memory/types.ts lib/memory/write.ts lib/db/memory-actions.ts lib/memory/__tests__/write.test.ts
git commit -m "feat(memory): write-path decision logic + pgvector DB actions"
```

---

## Task 3: Extraction pass (granite)

**Files:**
- Create: `lib/agents/memory-extractor.ts`
- Test: `lib/agents/__tests__/memory-extractor.test.ts`

**Interfaces:**
- Consumes: the same Ollama-host + `createTimeoutFetch` pattern as `lib/agents/query-classifier.ts`.
- Produces: `extractMemories({ userMessage, standaloneQuery, abortSignal }): Promise<MemoryCandidate[]>` (returns `[]` on nothing/failure).

- [ ] **Step 1: Write the failing test**

Create `lib/agents/__tests__/memory-extractor.test.ts` mirroring `query-classifier.test.ts`'s mocking (mock `ai`'s `generateText`, `ai-sdk-ollama`, `createTimeoutFetch`):

```typescript
import { generateText } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { extractMemories } from '../memory-extractor'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})
vi.mock('ai-sdk-ollama', () => ({
  createOllama: vi.fn(() => vi.fn(modelId => ({ modelId })))
}))
vi.mock('../../utils/fetch-with-timeout', () => ({
  createTimeoutFetch: vi.fn(() => vi.fn())
}))

const mockGen = vi.mocked(generateText)

describe('extractMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CLASSIFIER_OLLAMA_BASE_URL = 'http://serenity:11434'
  })
  afterEach(() => {
    delete process.env.CLASSIFIER_OLLAMA_BASE_URL
  })

  it('returns extracted candidates', async () => {
    mockGen.mockResolvedValue({
      output: {
        memories: [
          { content: 'Self-hosts their infrastructure', category: 'fact' }
        ]
      }
    } as any)
    const res = await extractMemories({
      userMessage: 'I run everything self-hosted on my own boxes'
    })
    expect(res).toEqual([
      { content: 'Self-hosts their infrastructure', category: 'fact' }
    ])
  })

  it('returns [] when the model finds nothing durable', async () => {
    mockGen.mockResolvedValue({ output: { memories: [] } } as any)
    expect(await extractMemories({ userMessage: 'what time is it' })).toEqual([])
  })

  it('returns [] on model error (fail-safe)', async () => {
    mockGen.mockRejectedValue(new Error('serenity down'))
    expect(await extractMemories({ userMessage: 'anything' })).toEqual([])
  })

  it('returns [] when the classifier host is unset', async () => {
    delete process.env.CLASSIFIER_OLLAMA_BASE_URL
    delete process.env.OLLAMA_BASE_URL
    expect(await extractMemories({ userMessage: 'x' })).toEqual([])
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun run test lib/agents/__tests__/memory-extractor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the extractor**

Create `lib/agents/memory-extractor.ts` (mirror `query-classifier.ts`'s structure — dedicated granite host, `createTimeoutFetch`, `Output.object`, `think:false`, `keep_alive:-1`, temperature 0, fail-safe `[]`):

```typescript
import { generateText, Output } from 'ai'
import { createOllama } from 'ai-sdk-ollama'
import { z } from 'zod'

import { createTimeoutFetch } from '../utils/fetch-with-timeout'
import type { MemoryCandidate } from '../memory/types'

const MODEL_ID = 'granite4.1:8b'
const TIMEOUT_MS = 10_000

const schema = z.object({
  memories: z.array(
    z.object({
      content: z.string(),
      category: z.enum(['preference', 'fact', 'interest'])
    })
  )
})

const SYSTEM_PROMPT = `You extract DURABLE facts about the USER that are worth remembering across future conversations.

Extract ONLY:
- stable preferences (how they like answers, tools/tech they favor)
- identity/role/context (their job, where they are, what they build)
- recurring interests
- lasting constraints

Do NOT extract:
- transient or one-off details tied to this specific question
- anything about the assistant's answer or the topic being researched
- sensitive personal data (health, politics, religion, finances) UNLESS the user explicitly states it as a lasting preference
- speculation — only what the user actually stated about themselves

Write each memory as a short third-person statement ("Prefers concise answers", "Self-hosts their infrastructure"). Return an empty array if nothing durable was stated — that is the common case; do not force memories.`

export async function extractMemories({
  userMessage,
  standaloneQuery,
  abortSignal
}: {
  userMessage: string
  standaloneQuery?: string
  abortSignal?: AbortSignal
}): Promise<MemoryCandidate[]> {
  const baseUrl =
    process.env.CLASSIFIER_OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL
  if (!baseUrl || !userMessage.trim()) return []

  try {
    const provider = createOllama({
      baseURL: baseUrl,
      fetch: createTimeoutFetch(TIMEOUT_MS, abortSignal)
    })
    const { output } = await generateText({
      model: provider(MODEL_ID, { think: false, keep_alive: -1 }),
      system: SYSTEM_PROMPT,
      prompt: `User message: ${userMessage}${
        standaloneQuery ? `\nResolved form: ${standaloneQuery}` : ''
      }`,
      temperature: 0,
      abortSignal,
      output: Output.object({ schema })
    })
    return (output?.memories ?? [])
      .map(m => ({ content: m.content.trim(), category: m.category }))
      .filter(m => m.content.length > 0)
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('memory extraction failed:', error)
    }
    return []
  }
}
```

- [ ] **Step 4: Run to confirm pass; commit**

Run: `bun run test lib/agents/__tests__/memory-extractor.test.ts` → PASS (4).
```bash
bun lint --fix && bun typecheck && npx prettier --write lib/agents/memory-extractor.ts lib/agents/__tests__/memory-extractor.test.ts
git add lib/agents/memory-extractor.ts lib/agents/__tests__/memory-extractor.test.ts
git commit -m "feat(memory): granite extraction pass for durable user facts"
```

---

## Task 4: Save orchestration + `remember` tool

**Files:**
- Modify: `lib/memory/write.ts` (add `saveCandidates` orchestrator)
- Create: `lib/tools/remember.ts`
- Modify: `lib/types/agent.ts` (add `remember` to `ResearcherTools`)
- Test: `lib/memory/__tests__/save.test.ts`

**Interfaces:**
- Consumes: `decideWrite` (Task 2), `nearestMemory`/`insertMemory`/`bumpMemory`/`supersedeMemory`/`evictOverCap`/`embedTexts` (Task 2).
- Produces: `saveCandidates(userId, candidates, opts): Promise<number>` (count saved/updated; never throws); `createRememberTool(userId)`.

- [ ] **Step 1: Write the failing test for `saveCandidates`**

Create `lib/memory/__tests__/save.test.ts` mocking the DB actions + embeddings so the orchestration is testable without a DB:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/embeddings/transformers-embedding', () => ({
  embedTexts: vi.fn(async (t: string[]) => t.map(() => [0.1, 0.2])),
  getConfiguredModel: vi.fn(() => 'm')
}))
vi.mock('@/lib/db/memory-actions', () => ({
  nearestMemory: vi.fn(),
  insertMemory: vi.fn(),
  bumpMemory: vi.fn(),
  supersedeMemory: vi.fn(),
  evictOverCap: vi.fn()
}))

import * as db from '@/lib/db/memory-actions'

import { saveCandidates } from '../write'

describe('saveCandidates', () => {
  beforeEach(() => vi.clearAllMocks())

  it('inserts a new candidate when nothing similar', async () => {
    vi.mocked(db.nearestMemory).mockResolvedValue(null)
    const n = await saveCandidates('u1', [
      { content: 'Self-hosts', category: 'fact' }
    ])
    expect(db.insertMemory).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ status: 'candidate', content: 'Self-hosts' })
    )
    expect(n).toBe(1)
  })

  it('bumps + graduates a near-duplicate candidate at the threshold', async () => {
    vi.mocked(db.nearestMemory).mockResolvedValue({
      id: 'm1',
      content: 'Self-hosts everything',
      status: 'candidate',
      sightings: 1,
      similarity: 0.97
    })
    await saveCandidates('u1', [{ content: 'Self-hosts', category: 'fact' }])
    expect(db.bumpMemory).toHaveBeenCalledWith('u1', 'm1', true)
    expect(db.insertMemory).not.toHaveBeenCalled()
  })

  it('never throws — a DB error is swallowed and counted as 0', async () => {
    vi.mocked(db.nearestMemory).mockRejectedValue(new Error('db down'))
    await expect(
      saveCandidates('u1', [{ content: 'x', category: 'fact' }])
    ).resolves.toBe(0)
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun run test lib/memory/__tests__/save.test.ts`
Expected: FAIL — `saveCandidates` not exported.

- [ ] **Step 3: Implement `saveCandidates` in `lib/memory/write.ts`**

Append to `lib/memory/write.ts`:

```typescript
import {
  bumpMemory,
  evictOverCap,
  insertMemory,
  nearestMemory,
  supersedeMemory
} from '@/lib/db/memory-actions'
import {
  embedTexts,
  getConfiguredModel
} from '@/lib/embeddings/transformers-embedding'

function config(): WriteConfig {
  const sim = Number(process.env.MEMORY_SIM_THRESHOLD)
  const grad = Number(process.env.MEMORY_GRADUATE_SIGHTINGS)
  return {
    simThreshold: Number.isFinite(sim) ? sim : 0.9,
    graduateSightings: Number.isFinite(grad) && grad > 0 ? grad : 2
  }
}

/**
 * Persist extracted/user-directed candidates. Embeds each, finds its nearest
 * existing memory, applies decideWrite, and writes. Never throws — memory is a
 * background enhancement (returns the count saved/updated). Caps per user.
 */
export async function saveCandidates(
  userId: string,
  candidates: MemoryCandidate[],
  opts: { sourceChatId?: string } = {}
): Promise<number> {
  if (candidates.length === 0) return 0
  const cfg = config()
  const cap = Number(process.env.MEMORY_MAX_PER_USER)
  let saved = 0
  try {
    const embeddings = await embedTexts(
      candidates.map(c => c.content),
      getConfiguredModel()
    )
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]
      const embedding = embeddings[i]
      const nearest = await nearestMemory(userId, embedding)
      const decision = decideWrite(candidate, nearest, cfg)
      if (decision.action === 'insert') {
        await insertMemory(userId, {
          content: candidate.content,
          category: candidate.category,
          status: decision.status,
          embedding,
          sourceChatId: opts.sourceChatId
        })
        saved++
      } else if (decision.action === 'bump') {
        await bumpMemory(userId, decision.id, decision.graduate)
        saved++
      }
      // 'supersede'/'skip' reserved for the granite contradiction pass
      // (consolidation, Task 6); the per-turn path uses insert/bump only.
    }
    await evictOverCap(userId, Number.isFinite(cap) && cap > 0 ? cap : 30)
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('saveCandidates failed:', error)
    }
  }
  return saved
}
```

- [ ] **Step 4: Implement the `remember` tool**

Create `lib/tools/remember.ts`:

```typescript
import { tool } from 'ai'
import { z } from 'zod'

import { saveCandidates } from '@/lib/memory/write'

/**
 * Lets the researcher save a durable user fact immediately (user-directed:
 * "remember that I …", or a clearly lasting preference the model recognizes).
 * Writes a CONFIRMED memory through the same dedup write path. Bound to the
 * current user; a missing userId makes it inert.
 */
export function createRememberTool(userId: string | undefined) {
  return tool({
    description:
      'Save a durable fact or preference about the user to long-term memory so future conversations remember it. Use when the user asks you to remember something, or states a clearly lasting preference/identity fact. Do NOT use for transient details about the current question.',
    inputSchema: z.object({
      content: z
        .string()
        .describe(
          'The fact as a short third-person statement, e.g. "Prefers concise answers"'
        ),
      category: z.enum(['preference', 'fact', 'interest'])
    }),
    execute: async ({ content, category }) => {
      if (!userId) return { saved: false }
      const n = await saveCandidates(userId, [
        { content, category, confirmed: true }
      ])
      return { saved: n > 0 }
    }
  })
}
```

Add `remember` to `ResearcherTools` in `lib/types/agent.ts` (mirror the existing tool keys):

```typescript
  remember: ReturnType<typeof import('@/lib/tools/remember').createRememberTool>
```

- [ ] **Step 5: Run tests; commit**

Run: `bun run test lib/memory/__tests__/save.test.ts` → PASS (3).
```bash
bun lint --fix && bun typecheck && npx prettier --write lib/memory/write.ts lib/tools/remember.ts lib/types/agent.ts lib/memory/__tests__/save.test.ts
git add lib/memory/write.ts lib/tools/remember.ts lib/types/agent.ts lib/memory/__tests__/save.test.ts
git commit -m "feat(memory): saveCandidates orchestrator + remember tool"
```

---

## Task 5: Researcher injection + streaming extraction hook

**Files:**
- Create: `lib/memory/inject.ts`
- Modify: `lib/agents/researcher.ts`
- Modify: `lib/streaming/create-chat-stream-response.ts` (+ `create-ephemeral-chat-stream-response.ts`)
- Test: `lib/memory/__tests__/inject.test.ts`

**Interfaces:**
- Consumes: `getConfirmedMemories`/`setLastUsed`/`isMemoryEnabled` (Task 2), `createRememberTool` (Task 4), `extractMemories` (Task 3), `saveCandidates` (Task 4).
- Produces: `buildMemoryBlock(memories): string`; `getMemoryInjection(userId): Promise<string>`; `createResearcher({ …, userId })`.

- [ ] **Step 1: Write the failing test for `buildMemoryBlock`**

Create `lib/memory/__tests__/inject.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import { buildMemoryBlock } from '../inject'

describe('buildMemoryBlock', () => {
  it('formats confirmed memories as a bulleted block', () => {
    const block = buildMemoryBlock([
      { content: 'Self-hosts their infrastructure' },
      { content: 'Prefers concise answers' }
    ])
    expect(block).toContain('What you know about this user')
    expect(block).toContain('- Self-hosts their infrastructure')
    expect(block).toContain('- Prefers concise answers')
  })

  it('returns empty string for no memories', () => {
    expect(buildMemoryBlock([])).toBe('')
  })
})
```

- [ ] **Step 2: Run to confirm it fails, then implement `lib/memory/inject.ts`**

Run: `bun run test lib/memory/__tests__/inject.test.ts` → FAIL.

Create `lib/memory/inject.ts`:

```typescript
import {
  getConfirmedMemories,
  isMemoryEnabled,
  setLastUsed
} from '@/lib/db/memory-actions'

export function buildMemoryBlock(
  memories: { content: string }[]
): string {
  if (memories.length === 0) return ''
  const lines = memories.map(m => `- ${m.content}`).join('\n')
  return `\n\n## What you know about this user\nThese are durable facts/preferences remembered from past conversations. Use them to personalize your answer when relevant; do not mention that you have memory unless asked.\n${lines}`
}

/**
 * The memory block to append to the researcher's system prompt for a user, or
 * '' when memory is disabled / empty / on any failure (fail-safe).
 */
export async function getMemoryInjection(
  userId: string | undefined
): Promise<string> {
  if (!userId) return ''
  try {
    if (!(await isMemoryEnabled(userId))) return ''
    const cap = Number(process.env.MEMORY_INJECT_TOP_K)
    const memories = await getConfirmedMemories(
      userId,
      Number.isFinite(cap) && cap > 0 ? cap : 30
    )
    if (memories.length === 0) return ''
    // usage signal for LRU eviction (fire-and-forget)
    void setLastUsed(
      userId,
      memories.map(m => m.id)
    ).catch(() => {})
    return buildMemoryBlock(memories)
  } catch {
    return ''
  }
}
```

Run: `bun run test lib/memory/__tests__/inject.test.ts` → PASS (2).

- [ ] **Step 3: Thread `userId` + memory into `createResearcher`**

In `lib/agents/researcher.ts`:
- Add `userId?: string` to `createResearcher`'s params + destructure.
- Import `createRememberTool` and `getMemoryInjection`.
- Build the remember tool and add it to the `tools` object and to each mode's `activeToolsList` (speed/balanced/quality/skip): `remember: createRememberTool(userId)` in `tools`; add `'remember'` to each `activeToolsList`.
- After the existing `systemInstructions` append block, await and append the memory block:
  ```typescript
  const memoryBlock = await getMemoryInjection(userId)
  if (memoryBlock) systemPrompt = systemPrompt + memoryBlock
  ```
  (Place it before the `ToolLoopAgent` is constructed so `instructions` include it. `createResearcher` is already `async`-friendly — it returns after building the agent; add the `await` inside its body.)

- [ ] **Step 4: Pass `userId` + kick off extraction in the streaming pipeline**

In `lib/streaming/create-chat-stream-response.ts`:
- Pass `userId` into the `researcher({ … })` call.
- In the `onFinish` handler (after `stripNarrationFromMessage`, where the turn is complete and non-aborted), kick off async extraction — fire-and-forget, never awaited into the response:
  ```typescript
  // Long-term memory: extract durable user facts from this turn (async,
  // non-blocking — mirrors title generation). Fully guarded + fail-safe.
  if (userId && process.env.MEMORY_ENABLED !== 'off') {
    void (async () => {
      try {
        if (!(await isMemoryEnabled(userId))) return
        const userText = getTextFromParts(message?.parts)
        if (!userText?.trim()) return
        const candidates = await extractMemories({
          userMessage: userText,
          standaloneQuery: classification?.standaloneQuery
        })
        if (candidates.length > 0) {
          await saveCandidates(userId, candidates, { sourceChatId: chatId })
        }
      } catch (error) {
        console.error('[memory] extraction failed:', error)
      }
    })()
  }
  ```
  Add the imports (`extractMemories`, `saveCandidates`, `isMemoryEnabled`, and reuse the existing `getTextFromParts`). Make the identical change in `create-ephemeral-chat-stream-response.ts`.

- [ ] **Step 5: Run tests (researcher + streaming suites), commit**

Run: `bun run test lib/memory/__tests__/inject.test.ts lib/agents/__tests__/researcher.test.ts`
Expected: PASS (memory injection is optional/`userId`-gated, so existing researcher tests are unaffected).
```bash
bun lint --fix && bun typecheck && npx prettier --write lib/memory/inject.ts lib/agents/researcher.ts lib/types/agent.ts lib/streaming/create-chat-stream-response.ts lib/streaming/create-ephemeral-chat-stream-response.ts lib/memory/__tests__/inject.test.ts
git add lib/memory/inject.ts lib/agents/researcher.ts lib/types/agent.ts lib/streaming/create-chat-stream-response.ts lib/streaming/create-ephemeral-chat-stream-response.ts lib/memory/__tests__/inject.test.ts
git commit -m "feat(memory): inject confirmed memories into researcher + async extraction on turn finish"
```

---

## Task 6: Minimal consolidation + cron route

**Files:**
- Create: `lib/agents/memory-consolidator.ts`
- Create: `app/api/memory/consolidate/route.ts`
- Test: `lib/agents/__tests__/memory-consolidator.test.ts`

**Interfaces:**
- Consumes: `listMemories`/`supersedeMemory`/`deleteMemory`/`evictOverCap` (Task 2); granite (extractor pattern).
- Produces: `consolidateUser(userId): Promise<{ merged: number; evicted: number }>`.

- [ ] **Step 1: Implement a minimal, testable consolidation**

Create `lib/agents/memory-consolidator.ts`. v1 keeps it mechanical + fail-safe: for a user's confirmed memories, collapse exact-duplicate contents (keep newest, delete the rest) and enforce the cap via `evictOverCap`. (Granite-based semantic merge of *near*-duplicates and contradiction resolution is a documented v1.1 extension — the per-turn write path already dedups by similarity, so v1 consolidation is a safety sweep.)

```typescript
import { deleteMemory, evictOverCap, listMemories } from '@/lib/db/memory-actions'

export async function consolidateUser(
  userId: string
): Promise<{ merged: number; evicted: number }> {
  let merged = 0
  try {
    const memories = await listMemories(userId)
    const seen = new Map<string, string>() // normalized content → keeper id
    for (const m of memories) {
      if (m.status !== 'confirmed') continue
      const key = m.content.trim().toLowerCase()
      if (seen.has(key)) {
        await deleteMemory(userId, m.id) // older dup (listMemories is desc updatedAt)
        merged++
      } else {
        seen.set(key, m.id)
      }
    }
    const cap = Number(process.env.MEMORY_MAX_PER_USER)
    await evictOverCap(userId, Number.isFinite(cap) && cap > 0 ? cap : 30)
  } catch (error) {
    console.error('[memory] consolidation failed for', userId, error)
  }
  return { merged, evicted: 0 }
}
```

Create `app/api/memory/consolidate/route.ts` — a POST endpoint a system cron can hit (guarded by a shared secret so it isn't publicly triggerable):

```typescript
import { NextResponse } from 'next/server'

import { consolidateAllActiveUsers } from '@/lib/agents/memory-consolidator'

export async function POST(request: Request) {
  const secret = process.env.MEMORY_CRON_SECRET
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const result = await consolidateAllActiveUsers()
  return NextResponse.json(result)
}
```

Add `consolidateAllActiveUsers()` to `memory-consolidator.ts` — selects distinct `user_id`s from `user_memories` (a non-RLS admin query via the base `db`) and runs `consolidateUser` for each; returns `{ users, merged }`. (Deployment note: wire a daily system cron to `POST /api/memory/consolidate` with the secret — a deploy step, not code.)

- [ ] **Step 2: Test the dup-collapse logic + commit**

Create `lib/agents/__tests__/memory-consolidator.test.ts` mocking the DB actions: two confirmed memories with identical normalized content → the older one is deleted, `merged === 1`; a DB error → resolves `{ merged: 0 }` (never throws). Run it green, then:
```bash
bun lint --fix && bun typecheck && npx prettier --write lib/agents/memory-consolidator.ts app/api/memory/consolidate/route.ts lib/agents/__tests__/memory-consolidator.test.ts
git add lib/agents/memory-consolidator.ts app/api/memory/consolidate/route.ts lib/agents/__tests__/memory-consolidator.test.ts
git commit -m "feat(memory): minimal consolidation sweep + cron route"
```

---

## Task 7: Memory settings UI + saved indicator

**Files:**
- Create: `lib/actions/memory.ts` (server actions)
- Create: `app/settings/memory/page.tsx` + `components/memory/memory-list.tsx`, `components/memory/memory-toggle.tsx`
- Modify: the settings navigation to link the Memory page
- Modify: `lib/streaming/create-chat-stream-response.ts` — stream a `data-memory` indicator when a save happens
- Test: `lib/actions/__tests__/memory.test.ts`

**Interfaces:**
- Consumes: `listMemories`/`deleteMemory`/`clearMemories`/`isMemoryEnabled`/`setMemoryEnabled` (Task 2), `getCurrentUser` (auth).
- Produces: server actions `getMemories()`, `deleteMemoryAction(id)`, `clearMemoriesAction()`, `getMemoryEnabled()`, `setMemoryEnabledAction(on)`; a Memory settings page.

- [ ] **Step 1: Server actions (auth + ownership) + test**

Create `lib/actions/memory.ts` mirroring `lib/actions/chat.ts`'s auth pattern (resolve `getCurrentUser()`, pass `user.id` to the RLS DB actions, `revalidatePath` where relevant). Add `lib/actions/__tests__/memory.test.ts` covering: unauthenticated → error; authenticated → delegates to the DB action with the user's id; each action (get/delete/clear/toggle). Mock `getCurrentUser` + the `memory-actions` module as neighboring tests do.

- [ ] **Step 2: Memory settings page + components**

Create `app/settings/memory/page.tsx` (server component: loads memories + toggle) and client components `memory-list.tsx` (renders memories with a delete button each + a "Clear all" using an `AlertDialog` like `ChatRow`) and `memory-toggle.tsx` (the on/off `Switch`). Wire the actions. Add a link to the memory page in the existing settings navigation. Use the existing shadcn components + `sonner` toasts, matching the app's patterns.

- [ ] **Step 3: "Memory updated" indicator**

In `create-chat-stream-response.ts`, when the async extraction/tool save reports ≥1 saved, stream a `data-memory` part (`writer.write({ type: 'data-memory', id: 'memory', data: { state: 'saved' } })`) — mirror the existing `data-classifier`/`data-attachments` indicator pattern, and render a subtle "Memory updated" chip in the message step UI where those indicators render. (Because extraction is async/post-finish, surface it on the next writer tick or as a lightweight toast — keep it non-blocking; if wiring it into the just-finished stream is awkward, a client-side toast on the settings refresh is an acceptable v1.)

- [ ] **Step 4: Run tests; commit**

Run: `bun run test lib/actions/__tests__/memory.test.ts` → PASS. Then:
```bash
bun lint --fix && bun typecheck && npx prettier --write lib/actions/memory.ts app/settings/memory/page.tsx components/memory/memory-list.tsx components/memory/memory-toggle.tsx lib/actions/__tests__/memory.test.ts
git add lib/actions/memory.ts app/settings/memory components/memory lib/actions/__tests__/memory.test.ts lib/streaming/create-chat-stream-response.ts
git commit -m "feat(memory): settings UI (list/delete/clear + toggle) and saved indicator"
```

---

## Task 8: Env docs + deployment notes

**Files:**
- Modify: `.env.local.example`

- [ ] **Step 1: Document the env vars**

Add to `.env.local.example`:

```bash
# Long-term per-user memory (auto-extracted durable facts, pgvector).
# Requires the pgvector/pgvector:pg17 Postgres image + migration. Inert when off.
# MEMORY_ENABLED=on            # only "off" disables globally
# MEMORY_SIM_THRESHOLD=0.90    # dedup cosine cutoff
# MEMORY_GRADUATE_SIGHTINGS=2  # candidate -> confirmed after N sightings
# MEMORY_MAX_PER_USER=30       # cap; LRU eviction beyond it
# MEMORY_INJECT_TOP_K=30       # injection cap
# MEMORY_CRON_SECRET=          # bearer for POST /api/memory/consolidate
```

- [ ] **Step 2: Commit**

```bash
git add .env.local.example
git commit -m "docs(memory): document memory env vars"
```

Deployment (not code steps): the Postgres image swap to `pgvector/pgvector:pg17` requires a container recreate; run `bun migrate` after (creates the extension + tables). Wire a daily system cron to `POST /api/memory/consolidate` with `MEMORY_CRON_SECRET`.

---

## Final verification (whole branch)

- [ ] **Full suite:** `bun run test` — all pass.
- [ ] **Lint + types + build:** `bun lint && bun typecheck && bun run build` — clean (build validates TypeScript; the container build has full env).
- [ ] **Migration on staging:** recreate the staging Postgres on the pgvector image, `bun migrate`, confirm `user_memories`/`user_settings` + the `vector` extension exist.
- [ ] **Staging E2E** (rebuild `admin-feature`, browser-test on `:3739`; do NOT push/redeploy prod until reviewed):
  1. State a durable preference (e.g. "I only want concise answers") in one turn, then again in a later turn/chat → it graduates to `confirmed` and the next answer visibly honors it; it appears in the Memory settings page.
  2. "Remember that I self-host everything" → saved immediately (settings list shows it); a later unrelated turn's system prompt includes it (answer reflects it when relevant).
  3. Toggle memory OFF for the user → no new memories saved, none injected; existing ones hidden from use.
  4. Delete a memory / clear all → gone from injection.
  5. serenity down (stop it briefly) → turns still complete; no memory saved; no user-visible error.
- [ ] **Summarize** all changes for review. Do not push/redeploy until the user approves.

---

## Self-Review (completed)

- **Spec coverage:** storage+migration → Task 1; write-path+DB → Task 2; extraction → Task 3; save orchestration + `remember` tool → Task 4; injection + async hook → Task 5; consolidation+cron → Task 6; UI+indicator → Task 7; env → Task 8. All spec sections covered.
- **Type consistency:** `MemoryCandidate`/`WriteDecision` (Task 2) consumed by Tasks 4–5; DB action signatures in Task 2 match their callers in Tasks 4–6; `createResearcher({ userId })` added Task 5 and set by the streaming pipeline; `remember` added to `ResearcherTools` (Task 4) and to `activeToolsList` (Task 5).
- **No placeholders:** every code step carries complete code except the UI (Task 7) and cron admin query (Task 6), which are specified precisely against existing patterns (`chat.ts` actions, `ChatRow` dialog, the indicator data-parts) — flagged so the implementer follows the named patterns rather than inventing.
- **Known deviations from strict TDD:** the DB actions (Task 2), the streaming hook (Task 5), the cron route (Task 6), and the UI (Task 7) are integration-covered by the staging E2E, not unit tests (they need a live Postgres/pgvector + auth); the pure logic (`decideWrite`, `saveCandidates`, `extractMemories`, `buildMemoryBlock`, consolidation dup-collapse, server actions) is all unit-tested. Called out so the reviewer doesn't flag it as a coverage gap.
