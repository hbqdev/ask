# Ask Memory (B) — Conversation Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Ask semantic recall over the user's own past conversations — "what did we decide about X?", "what was that proxy you recommended?" — answered from what was actually discussed, across all their chats.

**Architecture:** A `conversation_chunks` pgvector table (RLS-isolated, FK-cascaded to `chats`/`messages`). Each turn's question and answer are chunked at 512/128 and embedded asynchronously. One hybrid retrieval core (`recallSearch`: vector ∪ keyword → optional cross-encoder rerank → threshold → top-K) serves three consumers: a per-turn auto-injection, a model-callable `recall` tool, and the Library search box. Everything fails safe and is inert when disabled.

**Tech Stack:** Next.js 16 / TS, PostgreSQL 17 + **pgvector** (already live in prod) + Drizzle, local embeddings (mxbai, 1024-d, transformers.js), self-hosted cross-encoder reranker, Vitest.

## Global Constraints

- **RLS-isolated per user** exactly like `chats`/`user_memories`: policy `user_id = (select current_setting('app.current_user_id', true))`; every user-scoped DB op goes through `withOptionalRLS(userId, tx => …)` (`lib/db/with-rls.ts`) **and** carries an explicit `user_id` predicate (defence in depth — the app's `morphic` role has BYPASSRLS, so the explicit predicate is the real isolation).
- **NEVER use `sql\`col = ANY(${jsArray})\``.** Drizzle renders a JS array in a `sql` template as a row-tuple `ANY(($1,$2,$3))`, which Postgres rejects at runtime. Use `inArray(col, arr)`. In feature A this exact bug hid behind a swallowed fire-and-forget `.catch()` and only the live E2E caught it. Every task touching multi-id SQL adds a `.toSQL()` assertion.
- **Fail-safe / non-blocking:** indexing runs async in `onFinish` and NEVER blocks a response or throws into the turn. Injection failure ⇒ no block, turn proceeds. Tool failure ⇒ empty result. Cross-encoder down ⇒ skip rerank, keep cosine order. Library search ⇒ falls back to `ILIKE`.
- **Inert when disabled:** `RECALL_ENABLED` env (only `'off'` disables) is the global switch; per-user `user_settings.recall_enabled` gates each user. Disabled ⇒ no indexing, no injection, **and no tool** — the tool must gate itself at execute time (feature A's I-1: the `remember` tool bypassed the kill switch because only injection/extraction were gated).
- **Embeddings** use `EMBEDDING_MODEL` (mxbai, **1024-d**); `conversation_chunks.embedding` is pinned to `vector(1024)`. A different model's dimension makes every write fail — guard with a loud `console.error` and skip, never a silent swallow.
- **FK cascade is a privacy requirement:** `chat_id` and `message_id` are `ON DELETE CASCADE`. A deleted chat's chunks MUST disappear or the model recalls conversations the user deleted. Verified in the E2E.
- **`score` semantics:** `score` is _cosine_ when `useRerank: false`, _cross-encoder score_ when rerank ran. Only the auto-inject path sets `minScore`, and it always runs `useRerank: false` — so `RECALL_INJECT_MIN_SCORE` is unambiguously a cosine gate. Never pair `minScore` with rerank.
- **UI hard rule:** every control must actually do what it appears to do. No decorative affordances, no fake progress, nothing that looks functional but isn't. "Rebuild index" polls real row counts; no "semantic" badge on a search that silently degrades to keyword.
- **Env defaults (exact):** `RECALL_ENABLED` on; `RECALL_INJECT_TOP_K` 2; `RECALL_INJECT_MIN_SCORE` 0.75; `RECALL_TOOL_TOP_K` 5; `RECALL_CHUNK_TOKENS` 512; `RECALL_CHUNK_OVERLAP` 128. Backfill route reuses `MEMORY_CRON_SECRET`.
- **Testing:** `bun run test` (NOT `bun test`). Pre-commit: `bun lint --fix`, `bun typecheck`, `npx prettier --write <only touched files>` (NOT `bun format` — it reformats the whole repo). Commit on `admin-feature`; do NOT push/redeploy until final verification.

---

## File Structure

- **Modify** `lib/db/schema.ts` — add `conversationChunks` table; add `recallEnabled` to `userSettings`.
- **Create** `drizzle/0017_conversation_chunks.sql` — hand-written migration (feature A's snapshots are stale; do NOT trust raw `drizzle-kit generate` output).
- **Create** `lib/db/recall-actions.ts` — all RLS'd chunk DB ops + the recall toggle.
- **Create** `lib/memory/recall-types.ts` — shared `RecallHit` / `RecallOptions`.
- **Create** `lib/memory/recall-index.ts` — idempotent `indexMessage`.
- **Create** `lib/memory/recall-search.ts` — the one hybrid retrieval core.
- **Create** `lib/memory/recall-backfill.ts` — resumable `backfillUser`.
- **Create** `app/api/memory/recall-backfill/route.ts` — cron-secret POST trigger.
- **Create** `lib/memory/recall-inject.ts` — `buildRecallBlock` + `getRecallInjection`.
- **Create** `lib/tools/recall.ts` — the `recall` tool.
- **Modify** `lib/types/agent.ts` — add `recall` to `ResearcherTools`.
- **Modify** `lib/types/ai.ts` — register the `recall` data part in `UIDataTypes`.
- **Modify** `lib/agents/researcher.ts` — accept `recallBlock`; wire the `recall` tool into `tools` + all 4 `activeToolsList`.
- **Modify** `lib/streaming/create-chat-stream-response.ts` — compute recall in `execute`, write `data-recall`, pass `recallBlock`; index the turn in `onFinish`.
- **Modify** `lib/db/actions.ts` — `searchUserChats` becomes hybrid with an `ILIKE` fallback.
- **Create** `lib/actions/recall.ts` — server actions for the settings UI.
- **Create** `components/recall-section.tsx` — attribution chips.
- **Create** `components/recall-tool-section.tsx` — the `tool-recall` step renderer.
- **Modify** `components/research-process-section.tsx`, `components/render-message.tsx` — part routing.
- **Modify** `components/settings/memory-tab.tsx` — two groups; recall toggle, real index status, Rebuild, Clear.
- **Modify** `.env.local.example` — document the `RECALL_*` vars.

---

## Task 1: Schema + migration

**Files:**

- Modify: `lib/db/schema.ts`
- Create: `drizzle/0017_conversation_chunks.sql`
- Modify: `drizzle/meta/_journal.json`
- Test: `lib/db/__tests__/recall-schema.test.ts`

**Interfaces:**

- Consumes: existing `chats`, `messages`, `userSettings`, `vector`, `pgPolicy`, `index`, `ID_LENGTH`, `USER_ID_LENGTH`, `VARCHAR_LENGTH`, `generateId` (all already imported in `schema.ts`).
- Produces: `conversationChunks` table + `ConversationChunk` type; `userSettings.recallEnabled`.

- [ ] **Step 1: Write the failing test**

Create `lib/db/__tests__/recall-schema.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import { conversationChunks, userSettings } from '../schema'

describe('conversationChunks schema', () => {
  it('has the columns the recall feature needs', () => {
    const cols = Object.keys(conversationChunks)
    for (const c of [
      'id',
      'userId',
      'chatId',
      'messageId',
      'role',
      'content',
      'chunkIndex',
      'embedding',
      'createdAt'
    ]) {
      expect(cols).toContain(c)
    }
  })
})

describe('userSettings schema', () => {
  it('has a per-user recall toggle alongside the memory toggle', () => {
    const cols = Object.keys(userSettings)
    expect(cols).toContain('memoryEnabled')
    expect(cols).toContain('recallEnabled')
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun run test lib/db/__tests__/recall-schema.test.ts`
Expected: FAIL — `conversationChunks` is not exported.

- [ ] **Step 3: Add the table + column to `lib/db/schema.ts`**

Append after the `userMemories` block:

```typescript
// Conversation recall (feature B). Chunked copies of message text, embedded
// for semantic retrieval. Unlike `user_memories` (whose source_chat_id has no
// FK on purpose — facts outlive their chat), these are DERIVED copies, so
// deleting a chat/message MUST delete its chunks or the model would recall
// conversations the user deleted.
export const conversationChunks = pgTable(
  'conversation_chunks',
  {
    id: varchar('id', { length: ID_LENGTH })
      .primaryKey()
      .$defaultFn(() => generateId()),
    userId: varchar('user_id', { length: USER_ID_LENGTH }).notNull(),
    chatId: varchar('chat_id', { length: ID_LENGTH })
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    messageId: varchar('message_id', { length: ID_LENGTH })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    role: varchar('role', {
      length: VARCHAR_LENGTH,
      enum: ['user', 'assistant']
    }).notNull(),
    content: text('content').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    embedding: vector('embedding', { dimensions: 1024 }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow()
  },
  table => [
    index('conversation_chunks_user_id_idx').on(table.userId),
    index('conversation_chunks_chat_id_idx').on(table.chatId),
    index('conversation_chunks_message_id_idx').on(table.messageId),
    index('conversation_chunks_embedding_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops')
    ),
    pgPolicy('users_manage_own_conversation_chunks', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: sql`user_id = (select current_setting('app.current_user_id', true))`,
      withCheck: sql`user_id = (select current_setting('app.current_user_id', true))`
    })
  ]
).enableRLS()

export type ConversationChunk = InferSelectModel<typeof conversationChunks>
```

In the existing `userSettings` table, add one column after `memoryEnabled`:

```typescript
    recallEnabled: boolean('recall_enabled').notNull().default(true),
```

- [ ] **Step 4: Hand-write the migration**

Do **not** trust `drizzle-kit generate` — snapshots 0012–0015 are missing, so it misdiffs and over-generates (this bit feature A). Write `drizzle/0017_conversation_chunks.sql` by hand with exactly the new objects:

```sql
CREATE TABLE IF NOT EXISTS "conversation_chunks" (
	"id" varchar(191) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"chat_id" varchar(191) NOT NULL,
	"message_id" varchar(191) NOT NULL,
	"role" varchar(256) NOT NULL,
	"content" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_chunks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conversation_chunks" ADD CONSTRAINT "conversation_chunks_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_chunks" ADD CONSTRAINT "conversation_chunks_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "conversation_chunks_user_id_idx" ON "conversation_chunks" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "conversation_chunks_chat_id_idx" ON "conversation_chunks" USING btree ("chat_id");
--> statement-breakpoint
CREATE INDEX "conversation_chunks_message_id_idx" ON "conversation_chunks" USING btree ("message_id");
--> statement-breakpoint
CREATE INDEX "conversation_chunks_embedding_idx" ON "conversation_chunks" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
CREATE POLICY "users_manage_own_conversation_chunks" ON "conversation_chunks" AS PERMISSIVE FOR ALL TO public USING (user_id = (select current_setting('app.current_user_id', true))) WITH CHECK (user_id = (select current_setting('app.current_user_id', true)));
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "recall_enabled" boolean DEFAULT true NOT NULL;
```

Note: `CREATE EXTENSION vector` is NOT needed — feature A's migration already created it and it is live in prod.

Add the journal entry to `drizzle/meta/_journal.json` after `0016_pgvector_user_memories`, using the same shape as its neighbours:

```json
{
  "idx": 17,
  "version": "7",
  "when": 1784200000000,
  "tag": "0017_conversation_chunks",
  "breakpoints": true
}
```

- [ ] **Step 5: Verify the migration replays on a throwaway pgvector DB**

```bash
docker run --rm -d --name pgv-test -e POSTGRES_PASSWORD=x -e POSTGRES_USER=morphic -e POSTGRES_DB=morphic -p 55433:5432 pgvector/pgvector:pg17
sleep 6
docker exec pgv-test psql -U morphic -d morphic -c "CREATE EXTENSION vector;"
# create minimal chats/messages parents so the FKs resolve, then replay 0017:
docker exec -i pgv-test psql -U morphic -d morphic <<'SQL'
CREATE TABLE chats (id varchar(191) PRIMARY KEY);
CREATE TABLE messages (id varchar(191) PRIMARY KEY);
CREATE TABLE user_settings (user_id varchar(255) PRIMARY KEY, memory_enabled boolean DEFAULT true NOT NULL);
SQL
docker exec -i pgv-test psql -U morphic -d morphic < drizzle/0017_conversation_chunks.sql
docker exec pgv-test psql -U morphic -d morphic -c "\d conversation_chunks"
docker rm -f pgv-test
```

Expected: table created with `vector(1024)`, hnsw index, policy; `user_settings.recall_enabled` added.

- [ ] **Step 6: Run tests, then commit**

Run: `bun run test lib/db/__tests__/recall-schema.test.ts` → PASS (2).

```bash
bun lint --fix && bun typecheck && npx prettier --write lib/db/schema.ts lib/db/__tests__/recall-schema.test.ts
git add lib/db/schema.ts drizzle/0017_conversation_chunks.sql drizzle/meta/_journal.json lib/db/__tests__/recall-schema.test.ts
git commit -m "feat(recall): conversation_chunks pgvector table + per-user recall toggle"
```

---

## Task 2: DB action layer

**Files:**

- Create: `lib/db/recall-actions.ts`
- Test: `lib/db/__tests__/recall-actions-sql.test.ts`

**Interfaces:**

- Consumes: `withOptionalRLS` (`lib/db/with-rls.ts`), `db` (`@/lib/db`), `conversationChunks`/`chats`/`messages`/`userSettings` (Task 1).
- Produces: `insertChunks(userId, rows)`; `deleteChunksForMessage(userId, messageId)`; `vectorSearchChunks(userId, embedding, n, excludeChatId?)`; `keywordSearchChunks(userId, term, n, excludeChatId?)`; `countChunks(userId)`; `clearChunks(userId)`; `messagesWithoutChunks(userId, limit)`; `isRecallEnabled(userId)`; `setRecallEnabled(userId, on)`. Row type `ChunkSearchRow = { chunkId, chatId, chatTitle, role, content, createdAt, score }`.

- [ ] **Step 1: Write the failing SQL-generation test**

This is the guard for the feature-A `ANY(array)` class of bug. Create `lib/db/__tests__/recall-actions-sql.test.ts`:

```typescript
import { and, eq, inArray } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { conversationChunks } from '../schema'

// Feature A shipped a bug where `sql`${col} = ANY(${jsArray})`` rendered as the
// row-tuple `ANY(($1,$2,$3))`, which Postgres rejects — it threw at runtime and
// was swallowed by a fire-and-forget catch. Mocked tests cannot catch a
// SQL-generation defect, so assert the compiled SQL directly.
describe('recall-actions SQL generation', () => {
  const dialect = new PgDialect()

  it('multi-id filters render as `in (...)`, never `ANY((...))`', () => {
    const where = and(
      eq(conversationChunks.userId, 'u1'),
      inArray(conversationChunks.id, ['a', 'b', 'c'])
    )
    const { sql } = dialect.sqlToQuery(where!.getSQL())
    expect(sql).toMatch(/"id" in \(\$/i)
    expect(sql.toLowerCase()).not.toContain('any((')
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun run test lib/db/__tests__/recall-actions-sql.test.ts`
Expected: FAIL — `conversationChunks` import resolves only after Task 1; if Task 1 is done this test passes immediately, which is fine (it is a standing guard, not a red-green driver).

- [ ] **Step 3: Implement `lib/db/recall-actions.ts`**

```typescript
import { and, desc, eq, ilike, inArray, ne, sql } from 'drizzle-orm'

import { db } from '.'
import { chats, conversationChunks, messages, userSettings } from './schema'
import { withOptionalRLS } from './with-rls'

const toVec = (v: number[]) => sql`${JSON.stringify(v)}::vector`

export interface ChunkSearchRow {
  chunkId: string
  chatId: string
  chatTitle: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
  score: number
}

export interface NewChunk {
  chatId: string
  messageId: string
  role: 'user' | 'assistant'
  content: string
  chunkIndex: number
  embedding: number[]
}

export async function insertChunks(userId: string, rows: NewChunk[]) {
  if (rows.length === 0) return
  await withOptionalRLS(userId, async tx => {
    await tx
      .insert(conversationChunks)
      .values(rows.map(r => ({ ...r, userId })))
  })
}

export async function deleteChunksForMessage(
  userId: string,
  messageId: string
) {
  await withOptionalRLS(userId, async tx => {
    await tx
      .delete(conversationChunks)
      .where(
        and(
          eq(conversationChunks.userId, userId),
          eq(conversationChunks.messageId, messageId)
        )
      )
  })
}

/** Vector arm: cosine similarity, nearest first. `score` is cosine in [0,1]. */
export async function vectorSearchChunks(
  userId: string,
  embedding: number[],
  n: number,
  excludeChatId?: string
): Promise<ChunkSearchRow[]> {
  return withOptionalRLS(userId, async tx => {
    const conds = [eq(conversationChunks.userId, userId)]
    if (excludeChatId) conds.push(ne(conversationChunks.chatId, excludeChatId))
    return tx
      .select({
        chunkId: conversationChunks.id,
        chatId: conversationChunks.chatId,
        chatTitle: chats.title,
        role: conversationChunks.role,
        content: conversationChunks.content,
        createdAt: conversationChunks.createdAt,
        score: sql<number>`1 - (${conversationChunks.embedding} <=> ${toVec(embedding)})`
      })
      .from(conversationChunks)
      .innerJoin(chats, eq(chats.id, conversationChunks.chatId))
      .where(and(...conds))
      .orderBy(sql`${conversationChunks.embedding} <=> ${toVec(embedding)}`)
      .limit(n) as Promise<ChunkSearchRow[]>
  })
}

/** Keyword arm: ILIKE. Keyword-only hits carry score 0 (see recall-search). */
export async function keywordSearchChunks(
  userId: string,
  term: string,
  n: number,
  excludeChatId?: string
): Promise<ChunkSearchRow[]> {
  return withOptionalRLS(userId, async tx => {
    const conds = [
      eq(conversationChunks.userId, userId),
      ilike(conversationChunks.content, `%${term}%`)
    ]
    if (excludeChatId) conds.push(ne(conversationChunks.chatId, excludeChatId))
    return tx
      .select({
        chunkId: conversationChunks.id,
        chatId: conversationChunks.chatId,
        chatTitle: chats.title,
        role: conversationChunks.role,
        content: conversationChunks.content,
        createdAt: conversationChunks.createdAt,
        score: sql<number>`0`
      })
      .from(conversationChunks)
      .innerJoin(chats, eq(chats.id, conversationChunks.chatId))
      .where(and(...conds))
      .orderBy(desc(conversationChunks.createdAt))
      .limit(n) as Promise<ChunkSearchRow[]>
  })
}

/** Real index status for the settings UI. */
export async function countChunks(
  userId: string
): Promise<{ chunks: number; chats: number }> {
  return withOptionalRLS(userId, async tx => {
    const rows = await tx
      .select({
        chunks: sql<number>`count(*)::int`,
        chats: sql<number>`count(distinct ${conversationChunks.chatId})::int`
      })
      .from(conversationChunks)
      .where(eq(conversationChunks.userId, userId))
    return { chunks: rows[0]?.chunks ?? 0, chats: rows[0]?.chats ?? 0 }
  })
}

export async function clearChunks(userId: string) {
  await withOptionalRLS(userId, async tx => {
    await tx
      .delete(conversationChunks)
      .where(eq(conversationChunks.userId, userId))
  })
}

/**
 * Backfill driver: the user's messages that have no chunks yet, with their
 * text assembled from ordered text parts. Resumable — call until it returns [].
 */
export async function messagesWithoutChunks(
  userId: string,
  limit = 25
): Promise<
  {
    messageId: string
    chatId: string
    role: 'user' | 'assistant'
    text: string
  }[]
> {
  return withOptionalRLS(userId, async tx => {
    const res = await tx.execute(sql`
      SELECT m.id AS "messageId",
             m.chat_id AS "chatId",
             m.role AS "role",
             string_agg(p.text_text, ' ' ORDER BY p."order") AS "text"
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      JOIN parts p ON p.message_id = m.id AND p.type = 'text'
      WHERE c.user_id = ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM conversation_chunks cc WHERE cc.message_id = m.id
        )
      GROUP BY m.id, m.chat_id, m.role
      HAVING string_agg(p.text_text, ' ' ORDER BY p."order") <> ''
      ORDER BY m.created_at ASC
      LIMIT ${limit}
    `)
    return (
      (res as unknown as { rows?: any[] }).rows ?? (res as unknown as any[])
    )
  })
}

/** Global kill switch first, then the per-user toggle (default on). */
export async function isRecallEnabled(userId: string): Promise<boolean> {
  if (process.env.RECALL_ENABLED === 'off') return false
  return withOptionalRLS(userId, async tx => {
    const rows = await tx
      .select({ enabled: userSettings.recallEnabled })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1)
    return rows[0]?.enabled ?? true
  })
}

export async function setRecallEnabled(userId: string, on: boolean) {
  await withOptionalRLS(userId, async tx => {
    await tx
      .insert(userSettings)
      .values({ userId, recallEnabled: on })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { recallEnabled: on, updatedAt: new Date() }
      })
  })
}
```

Note `inArray` is imported and available for any future multi-id filter — never reach for `ANY(${array})`.

- [ ] **Step 4: Run tests; commit**

Run: `bun run test lib/db/__tests__/recall-actions-sql.test.ts` → PASS (1).

```bash
bun lint --fix && bun typecheck && npx prettier --write lib/db/recall-actions.ts lib/db/__tests__/recall-actions-sql.test.ts
git add lib/db/recall-actions.ts lib/db/__tests__/recall-actions-sql.test.ts
git commit -m "feat(recall): RLS'd conversation-chunk DB actions"
```

---

## Task 3: Indexing (idempotent)

**Files:**

- Create: `lib/memory/recall-types.ts`
- Create: `lib/memory/recall-index.ts`
- Test: `lib/memory/__tests__/recall-index.test.ts`

**Interfaces:**

- Consumes: `splitText` (`lib/embeddings/split-text.ts`), `embedTexts`/`getConfiguredModel` (`lib/embeddings/transformers-embedding.ts`), `deleteChunksForMessage`/`insertChunks`/`isRecallEnabled` (Task 2).
- Produces: `indexMessage(userId, chatId, messageId, role, text): Promise<number>` (chunks written; never throws). `RecallHit`/`RecallOptions` types.

- [ ] **Step 1: Create the shared types**

Create `lib/memory/recall-types.ts`:

```typescript
export interface RecallHit {
  chunkId: string
  chatId: string
  chatTitle: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
  /** Cosine similarity when useRerank is false; cross-encoder score when it ran. */
  score: number
}

export interface RecallOptions {
  topK: number
  useRerank: boolean
  excludeChatId?: string
  /** Only valid with useRerank: false — it is a cosine threshold. */
  minScore?: number
}
```

- [ ] **Step 2: Write the failing test**

Create `lib/memory/__tests__/recall-index.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/embeddings/transformers-embedding', () => ({
  embedTexts: vi.fn(async (t: string[]) =>
    t.map(() => new Array(1024).fill(0.1))
  ),
  getConfiguredModel: vi.fn(() => 'm')
}))
vi.mock('@/lib/db/recall-actions', () => ({
  deleteChunksForMessage: vi.fn(),
  insertChunks: vi.fn(),
  isRecallEnabled: vi.fn(async () => true)
}))

import * as db from '@/lib/db/recall-actions'
import { embedTexts } from '@/lib/embeddings/transformers-embedding'

import { indexMessage } from '../recall-index'

describe('indexMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(db.isRecallEnabled).mockResolvedValue(true)
  })

  it('deletes existing chunks before inserting (idempotent re-index)', async () => {
    const n = await indexMessage('u1', 'c1', 'm1', 'user', 'hello world')
    expect(db.deleteChunksForMessage).toHaveBeenCalledWith('u1', 'm1')
    expect(db.insertChunks).toHaveBeenCalled()
    expect(n).toBeGreaterThan(0)
  })

  it('is inert when recall is disabled', async () => {
    vi.mocked(db.isRecallEnabled).mockResolvedValue(false)
    expect(await indexMessage('u1', 'c1', 'm1', 'user', 'hello')).toBe(0)
    expect(db.insertChunks).not.toHaveBeenCalled()
  })

  it('skips loudly on an embedding dimension mismatch', async () => {
    vi.mocked(embedTexts).mockResolvedValueOnce([[0.1, 0.2]])
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await indexMessage('u1', 'c1', 'm1', 'user', 'hello')).toBe(0)
    expect(db.insertChunks).not.toHaveBeenCalled()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('never throws — a DB error resolves to 0', async () => {
    vi.mocked(db.insertChunks).mockRejectedValueOnce(new Error('db down'))
    await expect(indexMessage('u1', 'c1', 'm1', 'user', 'hello')).resolves.toBe(
      0
    )
  })

  it('returns 0 for empty text without touching the DB', async () => {
    expect(await indexMessage('u1', 'c1', 'm1', 'user', '   ')).toBe(0)
    expect(db.deleteChunksForMessage).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run to confirm it fails**

Run: `bun run test lib/memory/__tests__/recall-index.test.ts`
Expected: FAIL — `../recall-index` not found.

- [ ] **Step 4: Implement `lib/memory/recall-index.ts`**

```typescript
import {
  deleteChunksForMessage,
  insertChunks,
  isRecallEnabled
} from '@/lib/db/recall-actions'
import { splitText } from '@/lib/embeddings/split-text'
import {
  embedTexts,
  getConfiguredModel
} from '@/lib/embeddings/transformers-embedding'

// Must match conversation_chunks.embedding vector(1024) — pinned to mxbai
// (EMBEDDING_MODEL). A mismatch means every insert fails, so fail LOUD.
const RECALL_EMBEDDING_DIM = 1024

function chunkTokens(): number {
  const n = Number(process.env.RECALL_CHUNK_TOKENS)
  return Number.isFinite(n) && n > 0 ? n : 512
}

function chunkOverlap(): number {
  const n = Number(process.env.RECALL_CHUNK_OVERLAP)
  return Number.isFinite(n) && n >= 0 ? n : 128
}

/**
 * Chunk + embed one message's text into conversation_chunks. Idempotent: any
 * existing chunks for the message are replaced, so a retry/edit re-indexes
 * cleanly. Never throws — recall is a background enhancement.
 */
export async function indexMessage(
  userId: string,
  chatId: string,
  messageId: string,
  role: 'user' | 'assistant',
  text: string
): Promise<number> {
  if (!text.trim()) return 0
  try {
    if (!(await isRecallEnabled(userId))) return 0

    const chunks = splitText(text, chunkTokens(), chunkOverlap())
    if (chunks.length === 0) return 0

    const embeddings = await embedTexts(chunks, getConfiguredModel())
    if (embeddings[0] && embeddings[0].length !== RECALL_EMBEDDING_DIM) {
      console.error(
        `[recall] embedding dimension mismatch: got ${embeddings[0].length}, expected ${RECALL_EMBEDDING_DIM}. ` +
          `Set EMBEDDING_MODEL=mixedbread-ai/mxbai-embed-large-v1. Skipping index.`
      )
      return 0
    }

    await deleteChunksForMessage(userId, messageId)
    await insertChunks(
      userId,
      chunks.map((content, i) => ({
        chatId,
        messageId,
        role,
        content,
        chunkIndex: i,
        embedding: embeddings[i]
      }))
    )
    return chunks.length
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('indexMessage failed:', error)
    }
    return 0
  }
}
```

- [ ] **Step 5: Run tests; commit**

Run: `bun run test lib/memory/__tests__/recall-index.test.ts` → PASS (5).

```bash
bun lint --fix && bun typecheck && npx prettier --write lib/memory/recall-types.ts lib/memory/recall-index.ts lib/memory/__tests__/recall-index.test.ts
git add lib/memory/recall-types.ts lib/memory/recall-index.ts lib/memory/__tests__/recall-index.test.ts
git commit -m "feat(recall): idempotent per-message chunk indexing"
```

---

## Task 4: Hybrid retrieval core

**Files:**

- Create: `lib/memory/recall-search.ts`
- Test: `lib/memory/__tests__/recall-search.test.ts`

**Interfaces:**

- Consumes: `vectorSearchChunks`/`keywordSearchChunks`/`isRecallEnabled` (Task 2), `embedTexts`/`getConfiguredModel`, `crossEncoderScore`/`isCrossEncoderConfigured` (`lib/utils/cross-encoder.ts`), `RecallHit`/`RecallOptions` (Task 3).
- Produces: `recallSearch(userId, query, opts: RecallOptions): Promise<RecallHit[]>` (never throws).

- [ ] **Step 1: Write the failing test**

Create `lib/memory/__tests__/recall-search.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/embeddings/transformers-embedding', () => ({
  embedTexts: vi.fn(async () => [new Array(1024).fill(0.1)]),
  getConfiguredModel: vi.fn(() => 'm')
}))
vi.mock('@/lib/db/recall-actions', () => ({
  vectorSearchChunks: vi.fn(async () => []),
  keywordSearchChunks: vi.fn(async () => []),
  isRecallEnabled: vi.fn(async () => true)
}))
vi.mock('@/lib/utils/cross-encoder', () => ({
  isCrossEncoderConfigured: vi.fn(() => false),
  crossEncoderScore: vi.fn(async () => [])
}))

import * as db from '@/lib/db/recall-actions'
import {
  crossEncoderScore,
  isCrossEncoderConfigured
} from '@/lib/utils/cross-encoder'

import { recallSearch } from '../recall-search'

const row = (over: Partial<any> = {}) => ({
  chunkId: 'k1',
  chatId: 'c1',
  chatTitle: 'Backups',
  role: 'assistant' as const,
  content: '3-2-1 rule',
  createdAt: new Date('2026-07-01'),
  score: 0.9,
  ...over
})

describe('recallSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(db.isRecallEnabled).mockResolvedValue(true)
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(false)
  })

  it('unions both arms and dedups by chunk id (vector score wins)', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([row({ score: 0.9 })])
    vi.mocked(db.keywordSearchChunks).mockResolvedValue([row({ score: 0 })])
    const hits = await recallSearch('u1', 'backups', {
      topK: 5,
      useRerank: false
    })
    expect(hits).toHaveLength(1)
    expect(hits[0].score).toBe(0.9)
  })

  it('applies minScore as a cosine gate when not reranking', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.5 })
    ])
    const hits = await recallSearch('u1', 'q', {
      topK: 5,
      useRerank: false,
      minScore: 0.75
    })
    expect(hits.map(h => h.chunkId)).toEqual(['a'])
  })

  it('reranks and overwrites score when the cross-encoder is configured', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.8 })
    ])
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
    vi.mocked(crossEncoderScore).mockResolvedValue([0.1, 0.99])
    const hits = await recallSearch('u1', 'q', { topK: 5, useRerank: true })
    expect(hits.map(h => h.chunkId)).toEqual(['b', 'a'])
    expect(hits[0].score).toBe(0.99)
  })

  it('falls back to cosine order when the reranker throws', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.8 })
    ])
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
    vi.mocked(crossEncoderScore).mockRejectedValue(new Error('reranker down'))
    const hits = await recallSearch('u1', 'q', { topK: 5, useRerank: true })
    expect(hits.map(h => h.chunkId)).toEqual(['a', 'b'])
  })

  it('passes excludeChatId to both arms', async () => {
    await recallSearch('u1', 'q', {
      topK: 5,
      useRerank: false,
      excludeChatId: 'c9'
    })
    expect(db.vectorSearchChunks).toHaveBeenCalledWith(
      'u1',
      expect.anything(),
      30,
      'c9'
    )
    expect(db.keywordSearchChunks).toHaveBeenCalledWith('u1', 'q', 30, 'c9')
  })

  it('is inert when recall is disabled, and never throws on error', async () => {
    vi.mocked(db.isRecallEnabled).mockResolvedValue(false)
    expect(
      await recallSearch('u1', 'q', { topK: 5, useRerank: false })
    ).toEqual([])
    vi.mocked(db.isRecallEnabled).mockResolvedValue(true)
    vi.mocked(db.vectorSearchChunks).mockRejectedValue(new Error('db down'))
    await expect(
      recallSearch('u1', 'q', { topK: 5, useRerank: false })
    ).resolves.toEqual([])
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun run test lib/memory/__tests__/recall-search.test.ts`
Expected: FAIL — `../recall-search` not found.

- [ ] **Step 3: Implement `lib/memory/recall-search.ts`**

```typescript
import {
  isRecallEnabled,
  keywordSearchChunks,
  vectorSearchChunks
} from '@/lib/db/recall-actions'
import {
  embedTexts,
  getConfiguredModel
} from '@/lib/embeddings/transformers-embedding'
import {
  crossEncoderScore,
  isCrossEncoderConfigured
} from '@/lib/utils/cross-encoder'

import type { RecallHit, RecallOptions } from './recall-types'

/**
 * The single hybrid retrieval core, shared by the auto-injection, the `recall`
 * tool, and the Library search box. Never throws — every caller degrades to
 * "no recall" rather than failing the turn.
 *
 * score semantics: cosine when useRerank is false, cross-encoder score when
 * rerank ran (step 5 overwrites). minScore is only ever paired with
 * useRerank: false, so it is unambiguously a cosine gate.
 */
export async function recallSearch(
  userId: string,
  query: string,
  opts: RecallOptions
): Promise<RecallHit[]> {
  if (!userId || !query.trim()) return []
  try {
    if (!(await isRecallEnabled(userId))) return []

    // Mirrors upload-rag's CANDIDATE_POOL sizing.
    const pool = Math.max(opts.topK * 3, 30)

    const [queryEmbedding] = await embedTexts([query], getConfiguredModel())

    const [vectorHits, keywordHits] = await Promise.all([
      vectorSearchChunks(userId, queryEmbedding, pool, opts.excludeChatId),
      keywordSearchChunks(userId, query, pool, opts.excludeChatId)
    ])

    // Union, dedup by chunk id — a chunk found by both keeps its cosine score.
    const byId = new Map<string, RecallHit>()
    for (const h of vectorHits) byId.set(h.chunkId, h as RecallHit)
    for (const h of keywordHits) {
      if (!byId.has(h.chunkId)) byId.set(h.chunkId, h as RecallHit)
    }
    let hits = [...byId.values()].sort((a, b) => b.score - a.score)

    if (opts.useRerank && isCrossEncoderConfigured() && hits.length > 1) {
      try {
        const scores = await crossEncoderScore(
          query,
          hits.map(h => h.content),
          // Chunks are 512 tokens — judge the whole chunk, like upload-rag.
          { maxLength: 512, timeoutMs: 10_000 }
        )
        hits = hits
          .map((h, i) => ({ ...h, score: scores[i] ?? 0 }))
          .sort((a, b) => b.score - a.score)
      } catch {
        // Reranker down — keep the cosine ordering already computed.
      }
    }

    if (opts.minScore !== undefined) {
      hits = hits.filter(h => h.score >= opts.minScore!)
    }

    return hits.slice(0, opts.topK)
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('recallSearch failed:', error)
    }
    return []
  }
}
```

- [ ] **Step 4: Run tests; commit**

Run: `bun run test lib/memory/__tests__/recall-search.test.ts` → PASS (6).

```bash
bun lint --fix && bun typecheck && npx prettier --write lib/memory/recall-search.ts lib/memory/__tests__/recall-search.test.ts
git add lib/memory/recall-search.ts lib/memory/__tests__/recall-search.test.ts
git commit -m "feat(recall): hybrid vector+keyword retrieval core with optional rerank"
```

---

## Task 5: Backfill + cron route

**Files:**

- Create: `lib/memory/recall-backfill.ts`
- Create: `app/api/memory/recall-backfill/route.ts`
- Test: `lib/memory/__tests__/recall-backfill.test.ts`

**Interfaces:**

- Consumes: `messagesWithoutChunks` (Task 2), `indexMessage` (Task 3), `db`/`conversationChunks` for the all-users sweep.
- Produces: `backfillUser(userId, opts?): Promise<{ messages: number; chunks: number }>`; `backfillAllUsers(): Promise<{ users: number; messages: number; chunks: number }>`.

- [ ] **Step 1: Write the failing test**

Create `lib/memory/__tests__/recall-backfill.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/recall-actions', () => ({
  messagesWithoutChunks: vi.fn()
}))
vi.mock('../recall-index', () => ({ indexMessage: vi.fn(async () => 3) }))

import * as db from '@/lib/db/recall-actions'

import { indexMessage } from '../recall-index'
import { backfillUser } from '../recall-backfill'

const msg = (id: string) => ({
  messageId: id,
  chatId: 'c1',
  role: 'user' as const,
  text: 'hello'
})

describe('backfillUser', () => {
  beforeEach(() => vi.clearAllMocks())

  it('drains batches until none remain and totals the counts', async () => {
    vi.mocked(db.messagesWithoutChunks)
      .mockResolvedValueOnce([msg('m1'), msg('m2')])
      .mockResolvedValueOnce([])
    const res = await backfillUser('u1')
    expect(res).toEqual({ messages: 2, chunks: 6 })
    expect(indexMessage).toHaveBeenCalledTimes(2)
  })

  it('stops at maxBatches so it can never spin forever', async () => {
    vi.mocked(db.messagesWithoutChunks).mockResolvedValue([msg('m1')])
    const res = await backfillUser('u1', { batchSize: 1, maxBatches: 3 })
    expect(res.messages).toBe(3)
  })

  it('never throws — a DB error returns what it managed', async () => {
    vi.mocked(db.messagesWithoutChunks).mockRejectedValue(new Error('db down'))
    await expect(backfillUser('u1')).resolves.toEqual({
      messages: 0,
      chunks: 0
    })
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun run test lib/memory/__tests__/recall-backfill.test.ts`
Expected: FAIL — `../recall-backfill` not found.

- [ ] **Step 3: Implement `lib/memory/recall-backfill.ts`**

```typescript
import { db } from '@/lib/db'
import { messagesWithoutChunks } from '@/lib/db/recall-actions'
import { chats } from '@/lib/db/schema'

import { indexMessage } from './recall-index'

/**
 * Index every message of this user that has no chunks yet. Idempotent and
 * resumable (the query itself skips already-indexed messages), batched so a
 * large history does not peg the CPU. Never throws.
 */
export async function backfillUser(
  userId: string,
  opts: { batchSize?: number; maxBatches?: number } = {}
): Promise<{ messages: number; chunks: number }> {
  const batchSize = opts.batchSize ?? 25
  const maxBatches = opts.maxBatches ?? 400
  let messages = 0
  let chunks = 0
  try {
    for (let i = 0; i < maxBatches; i++) {
      const batch = await messagesWithoutChunks(userId, batchSize)
      if (batch.length === 0) break
      for (const m of batch) {
        chunks += await indexMessage(
          userId,
          m.chatId,
          m.messageId,
          m.role,
          m.text
        )
        messages++
      }
    }
  } catch (error) {
    console.error('[recall] backfill failed for', userId, error)
  }
  return { messages, chunks }
}

/** Cron sweep: backfill every user who has chats. Non-RLS user-id read only. */
export async function backfillAllUsers(): Promise<{
  users: number
  messages: number
  chunks: number
}> {
  let messages = 0
  let chunks = 0
  const rows = await db.selectDistinct({ userId: chats.userId }).from(chats)
  for (const { userId } of rows) {
    const r = await backfillUser(userId)
    messages += r.messages
    chunks += r.chunks
  }
  return { users: rows.length, messages, chunks }
}
```

The distinct read is intentionally non-RLS (a cron must enumerate users); every downstream op re-enters per-user RLS via `messagesWithoutChunks`/`indexMessage`.

- [ ] **Step 4: Create the route**

Create `app/api/memory/recall-backfill/route.ts` (same guard shape as the consolidate route):

```typescript
import { NextResponse } from 'next/server'

import { backfillAllUsers } from '@/lib/memory/recall-backfill'

export async function POST(request: Request) {
  const secret = process.env.MEMORY_CRON_SECRET
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const result = await backfillAllUsers()
  return NextResponse.json(result)
}
```

- [ ] **Step 5: Run tests; commit**

Run: `bun run test lib/memory/__tests__/recall-backfill.test.ts` → PASS (3).

```bash
bun lint --fix && bun typecheck && npx prettier --write lib/memory/recall-backfill.ts app/api/memory/recall-backfill/route.ts lib/memory/__tests__/recall-backfill.test.ts
git add lib/memory/recall-backfill.ts app/api/memory/recall-backfill/route.ts lib/memory/__tests__/recall-backfill.test.ts
git commit -m "feat(recall): resumable backfill + cron route"
```

---

## Task 6: The `recall` tool + researcher wiring

**Files:**

- Create: `lib/tools/recall.ts`
- Modify: `lib/types/agent.ts`
- Modify: `lib/agents/researcher.ts`
- Test: `lib/tools/__tests__/recall.test.ts`

**Interfaces:**

- Consumes: `recallSearch` (Task 4), `isRecallEnabled` (Task 2).
- Produces: `createRecallTool(userId, currentChatId)`; `ResearcherTools['recall']`.

- [ ] **Step 1: Write the failing test**

Create `lib/tools/__tests__/recall.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/memory/recall-search', () => ({ recallSearch: vi.fn() }))
vi.mock('@/lib/db/recall-actions', () => ({ isRecallEnabled: vi.fn() }))

import { isRecallEnabled } from '@/lib/db/recall-actions'
import { recallSearch } from '@/lib/memory/recall-search'

import { createRecallTool } from '../recall'

const hit = {
  chunkId: 'k1',
  chatId: 'c1',
  chatTitle: 'Backups',
  role: 'assistant' as const,
  content: '3-2-1 rule',
  createdAt: new Date('2026-07-01'),
  score: 0.9
}

describe('createRecallTool', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is inert without a userId and never searches', async () => {
    const tool = createRecallTool(undefined, 'c1')
    expect(await tool.execute!({ query: 'x' }, {} as any)).toEqual({
      results: []
    })
    expect(recallSearch).not.toHaveBeenCalled()
  })

  it('is inert when recall is disabled (kill switch gates the TOOL too)', async () => {
    vi.mocked(isRecallEnabled).mockResolvedValue(false)
    const tool = createRecallTool('u1', 'c1')
    expect(await tool.execute!({ query: 'x' }, {} as any)).toEqual({
      results: []
    })
    expect(recallSearch).not.toHaveBeenCalled()
  })

  it('returns hits and excludes the current chat', async () => {
    vi.mocked(isRecallEnabled).mockResolvedValue(true)
    vi.mocked(recallSearch).mockResolvedValue([hit])
    const tool = createRecallTool('u1', 'c1')
    const res = (await tool.execute!({ query: 'backups' }, {} as any)) as any
    expect(res.results).toHaveLength(1)
    expect(res.results[0].chatTitle).toBe('Backups')
    expect(recallSearch).toHaveBeenCalledWith(
      'u1',
      'backups',
      expect.objectContaining({ useRerank: true, excludeChatId: 'c1' })
    )
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun run test lib/tools/__tests__/recall.test.ts`
Expected: FAIL — `../recall` not found.

- [ ] **Step 3: Implement `lib/tools/recall.ts`**

```typescript
import { tool } from 'ai'
import { z } from 'zod'

import { isRecallEnabled } from '@/lib/db/recall-actions'
import { recallSearch } from '@/lib/memory/recall-search'

function toolTopK(): number {
  const n = Number(process.env.RECALL_TOOL_TOP_K)
  return Number.isFinite(n) && n > 0 ? n : 5
}

/**
 * Lets the researcher search the user's OWN past conversations. Bound to the
 * current user; a missing userId or a disabled toggle makes it inert (the
 * kill switch must gate the tool itself, not just injection).
 */
export function createRecallTool(
  userId: string | undefined,
  currentChatId: string | undefined
) {
  return tool({
    description:
      'Search the user\'s own past conversations for what was previously discussed or decided. Use when the user refers to earlier context ("what did we decide about X", "that tool you recommended"). Do NOT use for general web knowledge — use search for that.',
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          'What to look for in the past conversations, in plain language'
        )
    }),
    execute: async ({ query }) => {
      if (!userId || !(await isRecallEnabled(userId))) return { results: [] }
      const hits = await recallSearch(userId, query, {
        topK: toolTopK(),
        useRerank: true,
        excludeChatId: currentChatId
      })
      return {
        results: hits.map(h => ({
          chatId: h.chatId,
          chatTitle: h.chatTitle,
          role: h.role,
          date: h.createdAt.toISOString().slice(0, 10),
          content: h.content
        }))
      }
    }
  })
}
```

- [ ] **Step 4: Register the tool type**

In `lib/types/agent.ts`, add to the `ResearcherTools` object literal (next to `remember`):

```typescript
recall: ReturnType<typeof import('@/lib/tools/recall').createRecallTool>
```

- [ ] **Step 5: Wire it into the researcher**

In `lib/agents/researcher.ts`:

1. Import it near the other tool imports:

```typescript
import { createRecallTool } from '../tools/recall'
```

2. Add `currentChatId?: string` to `createResearcher`'s params object **and** its type block (alongside `userId`), with this comment:

```typescript
// The chat this turn belongs to — excluded from recall results so the tool
// never returns the conversation the user is already in.
currentChatId
```

3. Add to the `tools` object literal (keep the `as ResearcherTools` cast):

```typescript
      recall: createRecallTool(userId, currentChatId),
```

4. Append `'recall'` to **all four** `activeToolsList` assignments (skip / speed / quality / balanced). A mode missing it silently cannot call the tool.

- [ ] **Step 6: Run tests; commit**

Run: `bun run test lib/tools/__tests__/recall.test.ts lib/agents/__tests__/researcher.test.ts` → PASS.

```bash
bun lint --fix && bun typecheck && npx prettier --write lib/tools/recall.ts lib/types/agent.ts lib/agents/researcher.ts lib/tools/__tests__/recall.test.ts
git add lib/tools/recall.ts lib/types/agent.ts lib/agents/researcher.ts lib/tools/__tests__/recall.test.ts
git commit -m "feat(recall): recall tool wired into the researcher, kill-switch gated"
```

---

## Task 7: Auto-injection + `data-recall` part

**Files:**

- Create: `lib/memory/recall-inject.ts`
- Modify: `lib/types/ai.ts`
- Modify: `lib/agents/researcher.ts`
- Modify: `lib/streaming/create-chat-stream-response.ts`
- Test: `lib/memory/__tests__/recall-inject.test.ts`

**Interfaces:**

- Consumes: `recallSearch` (Task 4), `RecallHit` (Task 3).
- Produces: `buildRecallBlock(hits): string`; `getRecallInjection(userId, query, currentChatId): Promise<{ block: string; hits: RecallHit[] }>`; `createResearcher({ …, recallBlock })`.

- [ ] **Step 1: Write the failing test**

Create `lib/memory/__tests__/recall-inject.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../recall-search', () => ({ recallSearch: vi.fn() }))

import { recallSearch } from '../recall-search'

import { buildRecallBlock, getRecallInjection } from '../recall-inject'

const hit = (over: Partial<any> = {}) => ({
  chunkId: 'k1',
  chatId: 'c1',
  chatTitle: 'Backups',
  role: 'assistant' as const,
  content: 'Use the 3-2-1 rule.',
  createdAt: new Date('2026-07-01'),
  score: 0.9,
  ...over
})

describe('buildRecallBlock', () => {
  it('formats hits with their chat title and date', () => {
    const block = buildRecallBlock([hit()])
    expect(block).toContain('Relevant past conversations')
    expect(block).toContain('Backups')
    expect(block).toContain('2026-07-01')
    expect(block).toContain('Use the 3-2-1 rule.')
  })

  it('returns empty string for no hits', () => {
    expect(buildRecallBlock([])).toBe('')
  })
})

describe('getRecallInjection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns an empty block without a userId and never searches', async () => {
    expect(await getRecallInjection(undefined, 'q', 'c1')).toEqual({
      block: '',
      hits: []
    })
    expect(recallSearch).not.toHaveBeenCalled()
  })

  it('excludes the current chat and does not rerank (cosine minScore gate)', async () => {
    vi.mocked(recallSearch).mockResolvedValue([hit()])
    const res = await getRecallInjection('u1', 'q', 'c9')
    expect(res.hits).toHaveLength(1)
    expect(recallSearch).toHaveBeenCalledWith(
      'u1',
      'q',
      expect.objectContaining({
        useRerank: false,
        excludeChatId: 'c9',
        minScore: 0.75
      })
    )
  })

  it('never throws — an error yields an empty block', async () => {
    vi.mocked(recallSearch).mockRejectedValue(new Error('boom'))
    await expect(getRecallInjection('u1', 'q', 'c1')).resolves.toEqual({
      block: '',
      hits: []
    })
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun run test lib/memory/__tests__/recall-inject.test.ts`
Expected: FAIL — `../recall-inject` not found.

- [ ] **Step 3: Implement `lib/memory/recall-inject.ts`**

```typescript
import { recallSearch } from './recall-search'
import type { RecallHit } from './recall-types'

function injectTopK(): number {
  const n = Number(process.env.RECALL_INJECT_TOP_K)
  return Number.isFinite(n) && n > 0 ? n : 2
}

function injectMinScore(): number {
  const n = Number(process.env.RECALL_INJECT_MIN_SCORE)
  return Number.isFinite(n) ? n : 0.75
}

export function buildRecallBlock(hits: RecallHit[]): string {
  if (hits.length === 0) return ''
  const lines = hits
    .map(
      h =>
        `- From "${h.chatTitle}" (${h.createdAt.toISOString().slice(0, 10)}): ${h.content}`
    )
    .join('\n')
  return `\n\n## Relevant past conversations\nThese are excerpts from this user's earlier conversations with you, retrieved because they look relevant. Use them when they help; ignore them when they do not. Do not claim to remember something they did not say.\n${lines}`
}

/**
 * The recall block to append to the researcher's system prompt, plus the hits
 * themselves so the caller can stream an attribution part. Fail-safe: an empty
 * block on no userId / disabled / no hits / any error.
 *
 * Deliberately useRerank: false — this runs on EVERY turn, so it stays a local
 * embed + an HNSW query with no network hop. minScore is the noise gate, and
 * it is a cosine threshold precisely because rerank is off here.
 */
export async function getRecallInjection(
  userId: string | undefined,
  query: string,
  currentChatId: string | undefined
): Promise<{ block: string; hits: RecallHit[] }> {
  if (!userId || !query?.trim()) return { block: '', hits: [] }
  try {
    const hits = await recallSearch(userId, query, {
      topK: injectTopK(),
      useRerank: false,
      excludeChatId: currentChatId,
      minScore: injectMinScore()
    })
    return { block: buildRecallBlock(hits), hits }
  } catch {
    return { block: '', hits: [] }
  }
}
```

- [ ] **Step 4: Register the `recall` data part**

In `lib/types/ai.ts`, add to `UIDataTypes` (after the `classifier` entry):

```typescript
  // Streamed by create-chat-stream-response.ts when confirmed past-conversation
  // excerpts were injected into this turn — rendered as attribution chips by
  // components/recall-section.tsx. Only written when recall actually injected.
  recall?: { chats: { chatId: string; title: string }[] }
```

- [ ] **Step 5: Accept `recallBlock` in the researcher**

In `lib/agents/researcher.ts`, add `recallBlock` to the params object and its type (`recallBlock?: string`), with the comment:

```typescript
// Past-conversation excerpts, retrieved in the streaming layer (it owns the
// resolved standaloneQuery and the stream writer). Appended to the system
// prompt next to the feature-A memory block.
recallBlock
```

Then, immediately after the existing memory-block append (currently lines 433-434):

```typescript
if (recallBlock) systemPrompt = systemPrompt + recallBlock
```

- [ ] **Step 6: Wire the streaming layer**

In `lib/streaming/create-chat-stream-response.ts`:

1. Add imports:

```typescript
import { getRecallInjection } from '../memory/recall-inject'
import { indexMessage } from '../memory/recall-index'
```

2. Inside `execute`, after `classification = await classificationPromise` (line ~288) and before the `researcher({...})` call (line ~319):

```typescript
// Past-conversation recall: retrieve here (not in createResearcher)
// because this scope owns both the resolved standaloneQuery and the
// stream writer needed for the attribution chips.
const recall = await getRecallInjection(
  userId,
  classification?.standaloneQuery || latestMessageText,
  chatId
)
if (recall.hits.length > 0) {
  writer.write({
    type: 'data-recall',
    id: 'recall',
    data: {
      chats: [
        ...new Map(
          recall.hits.map(h => [
            h.chatId,
            { chatId: h.chatId, title: h.chatTitle }
          ])
        ).values()
      ]
    }
  })
}
```

3. Add these two args to the `researcher({ … })` call:

```typescript
          currentChatId: chatId,
          recallBlock: recall.block,
```

4. In the `onFinish` handler, inside the existing non-aborted branch and alongside the feature-A extraction block, add the turn indexing (fire-and-forget, never awaited):

```typescript
// Conversation recall: index this turn's question + answer (async,
// non-blocking — mirrors the memory extraction above).
if (userId && process.env.RECALL_ENABLED !== 'off') {
  void (async () => {
    try {
      const userText = getTextFromParts(message?.parts)
      if (userText?.trim() && message?.id) {
        await indexMessage(userId, chatId, message.id, 'user', userText)
      }
      const answerText = getTextFromParts(cleanedMessage?.parts)
      if (answerText?.trim() && cleanedMessage?.id) {
        await indexMessage(
          userId,
          chatId,
          cleanedMessage.id,
          'assistant',
          answerText
        )
      }
    } catch (error) {
      console.error('[recall] indexing failed:', error)
    }
  })()
}
```

Do **not** touch `create-ephemeral-chat-stream-response.ts` beyond nothing at all — it has no `userId`, so recall stays inert there (its `researcher(...)` call simply omits `currentChatId`/`recallBlock`, which are optional).

- [ ] **Step 7: Run tests; commit**

Run: `bun run test lib/memory/__tests__/recall-inject.test.ts lib/agents/__tests__/researcher.test.ts` → PASS.

```bash
bun lint --fix && bun typecheck && npx prettier --write lib/memory/recall-inject.ts lib/types/ai.ts lib/agents/researcher.ts lib/streaming/create-chat-stream-response.ts lib/memory/__tests__/recall-inject.test.ts
git add lib/memory/recall-inject.ts lib/types/ai.ts lib/agents/researcher.ts lib/streaming/create-chat-stream-response.ts lib/memory/__tests__/recall-inject.test.ts
git commit -m "feat(recall): per-turn auto-injection + turn indexing + data-recall part"
```

---

## Task 8: Library search goes hybrid

**Files:**

- Modify: `lib/db/actions.ts` (`searchUserChats`, ~line 653)
- Test: `lib/db/__tests__/search-user-chats.test.ts`

**Interfaces:**

- Consumes: `recallSearch` (Task 4).
- Produces: `searchUserChats(userId, query, limit)` — unchanged signature and `ChatSearchResult[]` return, now semantic with a keyword fallback.

- [ ] **Step 1: Write the failing test**

Create `lib/db/__tests__/search-user-chats.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/memory/recall-search', () => ({ recallSearch: vi.fn() }))

import { recallSearch } from '@/lib/memory/recall-search'

import { searchUserChatsHybrid } from '../actions'

const hit = {
  chunkId: 'k1',
  chatId: 'c1',
  chatTitle: 'Backups',
  role: 'assistant' as const,
  content: 'Use the 3-2-1 rule for backups.',
  createdAt: new Date('2026-07-01'),
  score: 0.9
}

describe('searchUserChatsHybrid', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps recall hits onto the ChatSearchResult shape, deduped per chat', async () => {
    vi.mocked(recallSearch).mockResolvedValue([hit, { ...hit, chunkId: 'k2' }])
    const res = await searchUserChatsHybrid('u1', 'backups', 20, async () => [])
    expect(res).toHaveLength(1)
    expect(res[0].chatId).toBe('c1')
    expect(res[0].chatTitle).toBe('Backups')
    expect(res[0].snippet).toContain('3-2-1')
  })

  it('falls back to the keyword path when recall returns nothing', async () => {
    vi.mocked(recallSearch).mockResolvedValue([])
    const fallback = vi.fn(async () => [
      {
        chatId: 'c9',
        chatTitle: 'Old',
        snippet: 'literal match',
        role: 'user',
        lastViewedAt: null
      }
    ])
    const res = await searchUserChatsHybrid('u1', 'zzz', 20, fallback as any)
    expect(fallback).toHaveBeenCalled()
    expect(res[0].chatId).toBe('c9')
  })

  it('falls back when recall throws — the search box must never break', async () => {
    vi.mocked(recallSearch).mockRejectedValue(new Error('down'))
    const fallback = vi.fn(async () => [])
    await expect(
      searchUserChatsHybrid('u1', 'q', 20, fallback as any)
    ).resolves.toEqual([])
    expect(fallback).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun run test lib/db/__tests__/search-user-chats.test.ts`
Expected: FAIL — `searchUserChatsHybrid` is not exported.

- [ ] **Step 3: Implement**

In `lib/db/actions.ts`, **rename** the existing `searchUserChats` body to `searchUserChatsKeyword` (same signature, unchanged logic — it is now the fallback), then add the hybrid entry point and a new `searchUserChats` that delegates:

```typescript
/**
 * Hybrid search core: semantic recall first, keyword as the floor. Extracted
 * with an injectable fallback so it is unit-testable without a DB.
 */
export async function searchUserChatsHybrid(
  userId: string,
  query: string,
  limit: number,
  fallback: (
    userId: string,
    query: string,
    limit: number
  ) => Promise<ChatSearchResult[]>
): Promise<ChatSearchResult[]> {
  try {
    const { recallSearch } = await import('@/lib/memory/recall-search')
    const hits = await recallSearch(userId, query, {
      topK: limit,
      useRerank: true
    })
    if (hits.length > 0) {
      // One row per chat, best-scoring chunk wins (hits are already sorted).
      const byChat = new Map<string, ChatSearchResult>()
      for (const h of hits) {
        if (byChat.has(h.chatId)) continue
        byChat.set(h.chatId, {
          chatId: h.chatId,
          chatTitle: h.chatTitle,
          snippet: h.content.slice(0, 150),
          role: h.role,
          lastViewedAt: null
        })
      }
      return [...byChat.values()]
    }
  } catch {
    // Index unavailable/disabled — fall through to keyword.
  }
  return fallback(userId, query, limit)
}

/**
 * Full-text search across chat titles and message text.
 * Semantic when the recall index has content; keyword otherwise — the user's
 * own search box must never break because of a memory setting.
 */
export async function searchUserChats(
  userId: string,
  query: string,
  limit = 20
): Promise<ChatSearchResult[]> {
  return searchUserChatsHybrid(userId, query, limit, searchUserChatsKeyword)
}
```

The `import()` is dynamic to keep `lib/db/actions.ts` free of a static dependency on the memory layer (which imports the embedder).

- [ ] **Step 4: Run tests; commit**

Run: `bun run test lib/db/__tests__/search-user-chats.test.ts` → PASS (3).

```bash
bun lint --fix && bun typecheck && npx prettier --write lib/db/actions.ts lib/db/__tests__/search-user-chats.test.ts
git add lib/db/actions.ts lib/db/__tests__/search-user-chats.test.ts
git commit -m "feat(recall): Library search goes hybrid with a keyword fallback"
```

---

## Task 9: UI — attribution chips + recall tool step

**Files:**

- Create: `components/recall-section.tsx`
- Create: `components/recall-tool-section.tsx`
- Modify: `components/research-process-section.tsx`
- Modify: `components/render-message.tsx`
- Test: `components/__tests__/recall-section.test.tsx`

**Interfaces:**

- Consumes: the `data-recall` part (Task 7), `ResearcherTools['recall']` (Task 6).
- Produces: `RecallSection`, `RecallPart`, `RecallData`, `RecallToolSection`.

**UI hard rule:** every chip links somewhere real. No decorative elements.

- [ ] **Step 1: Write the failing test**

Create `components/__tests__/recall-section.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { RecallSection } from '../recall-section'

describe('RecallSection', () => {
  it('renders one linked chip per recalled chat', () => {
    render(
      <RecallSection
        data={{
          chats: [
            { chatId: 'c1', title: 'Backups' },
            { chatId: 'c2', title: 'Monitoring' }
          ]
        }}
      />
    )
    const backups = screen.getByRole('link', { name: /Backups/ })
    expect(backups).toHaveAttribute('href', '/search/c1')
    expect(screen.getByRole('link', { name: /Monitoring/ })).toHaveAttribute(
      'href',
      '/search/c2'
    )
  })

  it('renders nothing when no chats were recalled', () => {
    const { container } = render(<RecallSection data={{ chats: [] }} />)
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun run test components/__tests__/recall-section.test.tsx`
Expected: FAIL — `../recall-section` not found.

- [ ] **Step 3: Implement `components/recall-section.tsx`**

```tsx
'use client'

import Link from 'next/link'

import { IconHistory } from '@tabler/icons-react'

import { cn } from '@/lib/utils'

// Mirrors the `recall` entry in UIDataTypes (lib/types/ai.ts) — the
// data-recall part streamed by create-chat-stream-response.ts when past
// conversation excerpts were injected into this turn.
export type RecallData = { chats: { chatId: string; title: string }[] }

export type RecallPart = {
  type: 'data-recall'
  id?: string
  data: RecallData
}

/**
 * Attribution for auto-injected recall: which past conversations shaped this
 * answer. Each chip navigates to that chat — recall stays inspectable rather
 * than spooky. Renders nothing when nothing was recalled.
 */
export function RecallSection({ data }: { data: RecallData }) {
  if (!data?.chats?.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <IconHistory size={14} className="shrink-0" />
      <span>Recalled from:</span>
      {data.chats.map(c => (
        <Link
          key={c.chatId}
          href={`/search/${c.chatId}`}
          className={cn(
            'max-w-[220px] truncate rounded-full border px-2 py-0.5',
            'hover:bg-muted transition-colors'
          )}
        >
          {c.title}
        </Link>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Implement `components/recall-tool-section.tsx`**

```tsx
'use client'

import Link from 'next/link'

import { IconHistory } from '@tabler/icons-react'

export interface RecallToolResult {
  results: {
    chatId: string
    chatTitle: string
    role: string
    date: string
    content: string
  }[]
}

/**
 * The research-process step for a `recall` tool call: what the model looked
 * for in the user's history and what it found. Each hit links to its chat.
 */
export function RecallToolSection({
  query,
  output
}: {
  query?: string
  output?: RecallToolResult
}) {
  const results = output?.results ?? []
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <IconHistory size={16} className="shrink-0" />
        <span>
          Searched your past conversations
          {query ? ` for “${query}”` : ''} → {results.length}{' '}
          {results.length === 1 ? 'result' : 'results'}
        </span>
      </div>
      {results.map((r, i) => (
        <Link
          key={`${r.chatId}-${i}`}
          href={`/search/${r.chatId}`}
          className="block rounded-md border p-2 hover:bg-muted transition-colors"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">{r.chatTitle}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {r.date}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {r.content}
          </p>
        </Link>
      ))}
    </div>
  )
}
```

- [ ] **Step 5: Route the parts**

In `components/research-process-section.tsx`, add the guard next to `isClassifierPart`:

```typescript
function isRecallPart(part: MessagePart): part is RecallPart {
  return part.type === 'data-recall'
}
```

Import `RecallPart`/`RecallSection` from `./recall-section` and render it in the step list wherever `isClassifierPart` is handled, using the same row treatment.

In `components/render-message.tsx`, add `data-recall` to the buffered part types (the `else if` at ~line 191):

```typescript
      part.type === 'data-classifier' ||
      part.type === 'data-recall' ||
```

- [ ] **Step 6: Run tests; commit**

Run: `bun run test components/__tests__/recall-section.test.tsx components/__tests__/research-process-section.test.tsx components/__tests__/render-message.test.tsx`
Expected: PASS — the 2 new tests, **and** the pre-existing suites for the two files this task modifies must stay green (they already cover the part-routing you are extending; a regression there means the new `data-recall` case broke classifier/attachments/tool routing).

```bash
bun lint --fix && bun typecheck && npx prettier --write components/recall-section.tsx components/recall-tool-section.tsx components/research-process-section.tsx components/render-message.tsx components/__tests__/recall-section.test.tsx
git add components/recall-section.tsx components/recall-tool-section.tsx components/research-process-section.tsx components/render-message.tsx components/__tests__/recall-section.test.tsx
git commit -m "feat(recall): attribution chips + recall tool step renderer"
```

---

## Task 10: UI — settings (toggle, real status, rebuild, clear)

**Files:**

- Create: `lib/actions/recall.ts`
- Modify: `components/settings/memory-tab.tsx`
- Test: `lib/actions/__tests__/recall.test.ts`

**Interfaces:**

- Consumes: `getCurrentUserId` (`@/lib/auth/get-current-user`), `countChunks`/`clearChunks`/`isRecallEnabled`/`setRecallEnabled` (Task 2), `backfillUser` (Task 5).
- Produces: `getRecallEnabled()`; `setRecallEnabledAction(on)`; `getRecallStatus()`; `rebuildRecallIndexAction()`; `clearRecallIndexAction()`.

**UI hard rule:** the status is a real row count; Rebuild really runs the backfill and the panel polls the real count; Clear really deletes.

- [ ] **Step 1: Write the failing test**

Create `lib/actions/__tests__/recall.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/get-current-user')
vi.mock('@/lib/db/recall-actions')
vi.mock('@/lib/memory/recall-backfill')

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import * as db from '@/lib/db/recall-actions'
import * as backfill from '@/lib/memory/recall-backfill'

import {
  clearRecallIndexAction,
  getRecallStatus,
  rebuildRecallIndexAction,
  setRecallEnabledAction
} from '../recall'

describe('recall actions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('getRecallStatus returns zeros for an unauthenticated user without hitting the DB', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)
    expect(await getRecallStatus()).toEqual({ chunks: 0, chats: 0 })
    expect(db.countChunks).not.toHaveBeenCalled()
  })

  it('getRecallStatus delegates with the user id', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue('u1')
    vi.mocked(db.countChunks).mockResolvedValue({ chunks: 12, chats: 3 })
    expect(await getRecallStatus()).toEqual({ chunks: 12, chats: 3 })
    expect(db.countChunks).toHaveBeenCalledWith('u1')
  })

  it('mutations refuse when unauthenticated', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)
    expect(await setRecallEnabledAction(false)).toEqual({
      success: false,
      error: 'User not authenticated'
    })
    expect(await clearRecallIndexAction()).toEqual({
      success: false,
      error: 'User not authenticated'
    })
    expect(db.setRecallEnabled).not.toHaveBeenCalled()
    expect(db.clearChunks).not.toHaveBeenCalled()
  })

  it('rebuild delegates to backfillUser with the user id', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue('u1')
    vi.mocked(backfill.backfillUser).mockResolvedValue({
      messages: 4,
      chunks: 9
    })
    expect(await rebuildRecallIndexAction()).toEqual({
      success: true,
      messages: 4,
      chunks: 9
    })
    expect(backfill.backfillUser).toHaveBeenCalledWith('u1')
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun run test lib/actions/__tests__/recall.test.ts`
Expected: FAIL — `../recall` not found.

- [ ] **Step 3: Implement `lib/actions/recall.ts`**

```typescript
'use server'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import {
  clearChunks,
  countChunks,
  isRecallEnabled,
  setRecallEnabled
} from '@/lib/db/recall-actions'
import { backfillUser } from '@/lib/memory/recall-backfill'

export async function getRecallEnabled(): Promise<boolean> {
  const userId = await getCurrentUserId()
  if (!userId) return true
  return isRecallEnabled(userId)
}

export async function setRecallEnabledAction(on: boolean) {
  const userId = await getCurrentUserId()
  if (!userId) return { success: false, error: 'User not authenticated' }
  await setRecallEnabled(userId, on)
  return { success: true }
}

/** Real row counts — the settings panel shows these, never a guess. */
export async function getRecallStatus(): Promise<{
  chunks: number
  chats: number
}> {
  const userId = await getCurrentUserId()
  if (!userId) return { chunks: 0, chats: 0 }
  return countChunks(userId)
}

export async function rebuildRecallIndexAction() {
  const userId = await getCurrentUserId()
  if (!userId) return { success: false, error: 'User not authenticated' }
  const { messages, chunks } = await backfillUser(userId)
  return { success: true, messages, chunks }
}

export async function clearRecallIndexAction() {
  const userId = await getCurrentUserId()
  if (!userId) return { success: false, error: 'User not authenticated' }
  await clearChunks(userId)
  return { success: true }
}
```

- [ ] **Step 4: Extend the Memory tab**

In `components/settings/memory-tab.tsx`:

1. Import the new actions and `AlertDialog` pieces already imported there.
2. Add state:

```typescript
const [recallEnabled, setRecallEnabledState] = useState(true)
const [status, setStatus] = useState<{ chunks: number; chats: number }>({
  chunks: 0,
  chats: 0
})
const [rebuilding, setRebuilding] = useState(false)
const [clearIndexOpen, setClearIndexOpen] = useState(false)
```

3. Load `getRecallEnabled()` and `getRecallStatus()` alongside the existing loads in the mount effect.
4. Render two labelled groups. Keep the existing facts UI under a **Facts** heading, then add:

```tsx
      <div className="space-y-4">
        <h4 className="text-sm font-medium">Conversation recall</h4>

        <SettingRow
          title="Conversation recall"
          description="Let Ask search your past conversations when they're relevant."
        >
          <SettingSwitch
            checked={recallEnabled}
            onCheckedChange={async next => {
              const prev = recallEnabled
              setRecallEnabledState(next)
              const res = await setRecallEnabledAction(next)
              if (!res.success) {
                setRecallEnabledState(prev)
                toast.error(res.error ?? 'Failed to update recall setting')
              }
            }}
          />
        </SettingRow>

        <SettingRow
          title="Index status"
          description={
            status.chunks === 0
              ? 'No conversations indexed yet — rebuild to start.'
              : `${status.chunks} chunks across ${status.chats} chats.`
          }
        >
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={rebuilding}
              onClick={async () => {
                setRebuilding(true)
                const res = await rebuildRecallIndexAction()
                setStatus(await getRecallStatus())
                setRebuilding(false)
                if (res.success) {
                  toast.success(`Indexed ${res.messages} messages (${res.chunks} chunks)`)
                } else {
                  toast.error(res.error ?? 'Rebuild failed')
                }
              }}
            >
              {rebuilding ? 'Indexing…' : 'Rebuild index'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={status.chunks === 0}
              onClick={() => setClearIndexOpen(true)}
            >
              Clear index
            </Button>
          </div>
        </SettingRow>
      </div>

      <AlertDialog open={clearIndexOpen} onOpenChange={setClearIndexOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the recall index?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes every indexed excerpt of your past conversations. Your
              chats themselves are not affected, and you can rebuild the index at
              any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async e => {
                e.preventDefault()
                setClearIndexOpen(false)
                const res = await clearRecallIndexAction()
                if (res.success) {
                  setStatus({ chunks: 0, chats: 0 })
                  toast.success('Recall index cleared')
                } else {
                  toast.error(res.error ?? 'Failed to clear index')
                }
              }}
            >
              Clear index
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
```

`Button` and the `AlertDialog*` primitives are already imported in `memory-tab.tsx` — no new imports needed for them.

**Every control above is real:** the toggle writes `user_settings.recall_enabled` and reverts on failure; the status string is a live row count re-read after each mutation; Rebuild runs the actual backfill and shows the true "Indexing…" state for its real duration; Clear really deletes.

- [ ] **Step 5: Run tests; commit**

Run: `bun run test lib/actions/__tests__/recall.test.ts` → PASS (4).

```bash
bun lint --fix && bun typecheck && npx prettier --write lib/actions/recall.ts components/settings/memory-tab.tsx lib/actions/__tests__/recall.test.ts
git add lib/actions/recall.ts components/settings/memory-tab.tsx lib/actions/__tests__/recall.test.ts
git commit -m "feat(recall): settings — recall toggle, real index status, rebuild, clear"
```

---

## Task 11: Env docs

**Files:**

- Modify: `.env.local.example`

- [ ] **Step 1: Document the vars**

Add to `.env.local.example`, immediately after the existing "Long-term memory" block:

```bash
# -----------------------------------------------------------------------------
# Conversation recall (memory feature B — RAG over your past Q&A)
# -----------------------------------------------------------------------------
# Semantic recall over the user's own past conversations, on the same pgvector
# store as long-term memory. Requires the same EMBEDDING_MODEL (mxbai, 1024-d) —
# conversation_chunks.embedding is pinned to vector(1024).
# Backfill existing history once after deploy:
#   curl -X POST -H "Authorization: Bearer $MEMORY_CRON_SECRET" \
#        http://localhost:3000/api/memory/recall-backfill
# (or use Settings → Memory → Rebuild index)
# RECALL_ENABLED=on              # global kill switch; only "off" disables
# RECALL_INJECT_TOP_K=2          # past excerpts auto-injected per turn
# RECALL_INJECT_MIN_SCORE=0.75   # cosine gate for auto-injection
# RECALL_TOOL_TOP_K=5            # results returned by the `recall` tool
# RECALL_CHUNK_TOKENS=512        # chunk size (matches the embedder's window)
# RECALL_CHUNK_OVERLAP=128       # chunk overlap
```

- [ ] **Step 2: Commit**

```bash
git add .env.local.example
git commit -m "docs(recall): document conversation-recall env vars"
```

---

## Task 12: End-to-end verification on staging (controller-run)

Run by the controller, not a subagent — it needs infra access. Staging is `ask-admin-feature` (:3739) with its own Postgres `ask-postgres-admin-feature` (already on `pgvector/pgvector:pg17`). **Prod must not be touched.**

- [ ] **Step 1: Deploy to staging**

```bash
cd /home/nightfury/selfhosted/ask
docker compose -f docker-compose.yaml -f docker-compose.admin-feature.yaml build ask
# anon override for a stable E2E user (untracked scratch file):
docker compose -f docker-compose.yaml -f docker-compose.admin-feature.yaml -f <anon-override>.yaml up -d --force-recreate --no-deps ask
docker logs ask-admin-feature 2>&1 | grep -iE "migrat|Ready|error"
```

Expected: "Migrations completed successfully", "Ready".

- [ ] **Step 2: Verify the migration**

```bash
docker exec ask-postgres-admin-feature psql -U morphic -d morphic -c "\d conversation_chunks"
docker exec ask-postgres-admin-feature psql -U morphic -d morphic -c "SELECT recall_enabled FROM user_settings LIMIT 1;"
```

Expected: `embedding vector(1024)`, the hnsw index, the RLS policy, both FKs; `recall_enabled` exists.

- [ ] **Step 3: Backfill real history**

```bash
curl -X POST -H "Authorization: Bearer $MEMORY_CRON_SECRET" http://localhost:3739/api/memory/recall-backfill
docker exec ask-postgres-admin-feature psql -U morphic -d morphic -c \
  "SELECT count(*) chunks, count(distinct chat_id) chats FROM conversation_chunks;"
```

Expected: non-zero counts. Confirm dimension: chunks embed at 1024 (a mismatch would have logged `[recall] embedding dimension mismatch`).

- [ ] **Step 4: Auto-injection + attribution chips**

Via the browser on `:3739`, ask something answerable only from history (e.g. a topic from an old chat) **without** restating it. Verify: the answer uses the past context; a "Recalled from: <chat title>" chip renders; clicking it opens that chat.

- [ ] **Step 5: The recall tool**

Ask "search our past conversations about X". Verify the `recall` tool step renders ("Searched your past conversations → N results") with linked hits.

- [ ] **Step 6: Kill switch**

Settings → Memory → toggle **Conversation recall** off. Confirm `user_settings.recall_enabled = f`. Then take a turn that states a fact and asks for recall. Verify: chunk count is frozen (no new indexing), no chips, and the tool returns nothing.

- [ ] **Step 7: Privacy — cascade on delete**

```bash
docker exec ask-postgres-admin-feature psql -U morphic -d morphic -c \
  "SELECT chat_id, count(*) FROM conversation_chunks GROUP BY chat_id LIMIT 1;"
# delete that chat via the Library UI, then:
docker exec ask-postgres-admin-feature psql -U morphic -d morphic -c \
  "SELECT count(*) FROM conversation_chunks WHERE chat_id = '<that id>';"
```

Expected: **0** — a deleted chat's chunks must be gone.

- [ ] **Step 8: Library search is semantic**

Search the Library for a paraphrase that has no literal match (e.g. "backups" against a chat that only says "3-2-1 rule"). Expected: the chat is found.

- [ ] **Step 9: Reranker-down degradation**

Temporarily unset `RERANKER_URL` for staging and repeat step 5. Expected: recall still returns results (cosine order), no error.

- [ ] **Step 10: Restore staging + report**

Restore staging to its normal config, clean E2E test data, and report results. Do **not** push or deploy to prod without explicit approval.

---
