# Ask Memory (B) — Conversation Recall (RAG over past Q&A)

**Date:** 2026-07-16
**Status:** Approved (design), pending implementation plan
**Component:** Ask — cross-session conversation recall (pgvector on the existing Postgres)

## Goal

Give Ask semantic recall over the user's own past conversations: "what did we
decide about X?", "what was that reverse proxy you recommended?" — answered from
what was actually discussed, across all of the user's chats.

This is **feature B**, the follow-on to **feature A** (auto-extracted user facts
& preferences, shipped and live). The two are complements, not overlaps:

- **Feature A** answers *who you are* — a small, curated set (~30 facts),
  injected on every turn.
- **Feature B** answers *what we already discussed* — the actual conversation
  content, retrieved only when relevant.

Both live on the same pgvector store and share the same fail-safe and
kill-switch philosophy.

## Background: what exists today

- **Keyword-only chat search already exists but the model cannot use it.**
  `searchUserChats` (`lib/db/actions.ts`) does an `ILIKE` substring match over
  `chats.title` and `parts.text_text`, RLS-scoped, exposed at
  `/api/chats/search` — wired **only** to the Library page UI. So "backups"
  never finds the chat that said "3-2-1 rule", and the researcher has no access
  to any of it.
- **Conversations** are `messages` (role, chat_id, created_at) + `parts`
  (`text_text` for text parts, ordered). A turn is a user message plus the
  assistant reply. RLS on `messages` is via `EXISTS` on `chats`.
- **The existing RAG precedent** (`lib/embeddings/upload-rag.ts`) chunks with
  `splitText(text, 512, 128)` → `embedTexts` → stores `.chunks.json` on **disk**
  → queries with **JS cosine** + cross-encoder rerank
  (`CANDIDATE_POOL = max(topK*3, 30)`). It predates pgvector; feature B does the
  same shape properly in pgvector.
- **Embedding window is the binding constraint:** `mxbai-embed-large-v1` has a
  512-token window, and `splitText` chunks at exactly `maxTokens=512,
  overlapTokens=128` (token-aware, `js-tiktoken`, sentence boundaries). That
  alignment is deliberate. Assistant answers routinely run ~1500+ tokens, so
  embedding a whole Q&A pair as one vector would silently truncate to the first
  third and lose most of the answer.
- **Feature A infrastructure to reuse:** pgvector + HNSW live in prod, local
  `embedTexts` (mxbai, 1024-d), the async `onFinish` fire-and-forget hook, the
  `user_settings` toggle table, and the self-hosted cross-encoder
  (`crossEncoderScore` / `isCrossEncoderConfigured`).

## Architecture

Seven units, each independently testable.

### 1. Storage — `conversation_chunks` (pgvector)

New Drizzle table, RLS-isolated exactly like `user_memories`:

| column | type | notes |
|---|---|---|
| `id` | varchar (cuid) | PK |
| `user_id` | varchar(255) | RLS key |
| `chat_id` | varchar | **FK → `chats.id`, ON DELETE CASCADE** |
| `message_id` | varchar | **FK → `messages.id`, ON DELETE CASCADE** |
| `role` | varchar enum | `user` \| `assistant` |
| `content` | text | the chunk text |
| `chunk_index` | integer | position within the message |
| `embedding` | `vector(1024)` | mxbai (`EMBEDDING_MODEL`) |
| `created_at` | timestamp | mirrors the message's date (recency) |

- RLS policy `users_manage_own_conversation_chunks` using
  `user_id = (select current_setting('app.current_user_id', true))` — mirrors
  `user_memories`.
- Indexes: HNSW on `embedding` (`vector_cosine_ops`); btree on `user_id`,
  `chat_id`, `message_id`.

**DB action layer** — `lib/db/recall-actions.ts`, mirroring
`lib/db/memory-actions.ts` (every operation through `withOptionalRLS(userId, …)`
*and* an explicit `user_id` predicate, per the established defence-in-depth
pattern):
`insertChunks(userId, rows)` · `deleteChunksForMessage(userId, messageId)` ·
`vectorSearchChunks(userId, embedding, n, excludeChatId?)` ·
`keywordSearchChunks(userId, term, n, excludeChatId?)` ·
`countChunks(userId): { chunks, chats }` · `clearChunks(userId)` ·
`messageIdsWithoutChunks(userId, limit)` (drives the resumable backfill) ·
`isRecallEnabled(userId)` / `setRecallEnabled(userId, on)` (reading and writing
`user_settings.recall_enabled`, and short-circuiting on
`RECALL_ENABLED === 'off'` exactly as `isMemoryEnabled` does).

**The FK cascade is load-bearing and is a deliberate inversion of feature A.**
`user_memories.source_chat_id` has no FK on purpose — a distilled fact outlives
its source chat. Chunks are the opposite: they are *derived copies of message
text*. If a chat (or a message) is deleted and its chunks survive, the model
recalls conversations the user deleted. That is a privacy defect, so deletion
must cascade — covering both `deleteChat` and per-message deletion.

### 2. Indexing — `lib/memory/recall-index.ts`

`indexMessage(userId, chatId, messageId, role, text)`:

1. `splitText(text, RECALL_CHUNK_TOKENS, RECALL_CHUNK_OVERLAP)` (512/128).
2. `embedTexts(chunks)` (local mxbai).
3. Delete any existing chunks for `messageId`, then insert — **idempotent**, so
   a retry/edit re-indexes cleanly instead of duplicating.

- **When:** in the same `onFinish` hook as feature A's extraction —
  fire-and-forget, after persistence, never awaited into the response. Indexes
  **both** the user's message and the assistant's answer for that turn.
- Gated on recall being enabled (global env + per-user toggle).
- Ephemeral/incognito path is **never indexed** (no `userId`) — consistent with
  feature A.
- Fail-safe: any error ⇒ no index change, zero user impact.
- Embedding dimension mismatch ⇒ loud `console.error` + skip (reuses feature A's
  guard; the schema is pinned to `vector(1024)`).

### 3. Backfill — `lib/memory/recall-backfill.ts`

`backfillUser(userId): Promise<{ messages: number; chunks: number }>` walks the
user's chats → messages → text parts and indexes any message that has no chunks
yet — **idempotent and resumable**, batched so it does not peg the CPU. Without
it the feature is dead on arrival (recall would find nothing until enough new
history accumulates), so backfill of existing history is in scope for v1.

Exposed two ways, both real:
- `POST /api/memory/recall-backfill`, guarded by the same `MEMORY_CRON_SECRET`
  bearer as the consolidation route.
- The **Rebuild index** control in settings (§8c).

### 4. Retrieval core — `lib/memory/recall-search.ts`

One core serves all three consumers; there is deliberately no second retrieval
implementation.

`recallSearch(userId, query, opts): Promise<RecallHit[]>` where `opts` is
`{ topK, useRerank, excludeChatId?, minScore? }`:

1. Embed `query` (local mxbai).
2. **Vector arm** — pgvector cosine over the user's chunks, top-N where
   `N = max(topK * 3, 30)` (matching upload-rag's `CANDIDATE_POOL`), excluding
   `excludeChatId`. Each hit's `score` is its cosine similarity in `[0,1]`.
3. **Keyword arm** — `ILIKE` over `content`, capped at the same `N`, same
   exclusion. Keyword-only hits (not also returned by the vector arm) carry no
   cosine score; they enter the pool with `score = 0` and rely on rerank (or on
   being surfaced by the caller when `minScore` is not set).
4. Union the arms, dedup by chunk `id` (a chunk found by both keeps its cosine
   score).
5. If `useRerank` and the cross-encoder is configured: `crossEncoderScore` and
   **overwrite** each hit's `score` with the rerank score, then sort by it;
   otherwise keep cosine order.
6. Filter by `minScore` when provided.
7. Return top-K.

`RecallHit = { chunkId, chatId, chatTitle, role, content, createdAt, score }`
(joins `chats` for the title).

**`score` semantics — read this before tuning thresholds.** `score` means
*cosine similarity* when `useRerank` is false, and *cross-encoder score* when
rerank ran; step 5 overwrites it. The two scales are not comparable, so
`minScore` must only ever be paired with a known `useRerank` setting. This is
why `RECALL_INJECT_MIN_SCORE` is safe: the auto-inject path (§5) is the only
caller that sets `minScore`, and it always runs with `useRerank: false`, so the
threshold is unambiguously a cosine gate. The tool and Library paths rerank and
do **not** pass `minScore`. Any future caller that wants a threshold on the
reranked scale needs its own separate constant.

The union arm is what makes both cases work: exact proper nouns ("Traefik",
which vector search alone handles poorly) and semantic paraphrase ("backups" →
"3-2-1 rule").

### 5. Auto-injection — into the researcher

Computed **in the streaming `execute`**, not inside `createResearcher`, because
it needs two things that only exist there: the classifier's resolved
`standaloneQuery`, and the `writer` for the attribution part (§8a).

- `getRecallInjection(userId, query, currentChatId)` →
  `recallSearch(topK = RECALL_INJECT_TOP_K, useRerank: false,
  excludeChatId: currentChatId, minScore: RECALL_INJECT_MIN_SCORE)`.
- On hits: `execute` writes the `data-recall` part, then passes a `recallBlock`
  string into `researcher({ …, recallBlock })`, which appends it to the system
  prompt alongside feature A's memory block. Block shape:
  `## Relevant past conversations` followed by, per hit,
  `- From "<chat title>" (<date>): <content>`.
- **Rerank is deliberately skipped on this path.** Per-turn cost stays a local
  embed (~50ms) plus an HNSW query (~ms) with no network hop, so turns that need
  no history pay almost nothing. `minScore` is the noise gate; the recall tool
  (§6) is the safety net for when that gate is too strict.
- The current chat is excluded — its context is already in the prompt.
- Fail-safe: `''` on any error, and the turn proceeds normally.

### 6. Recall tool — `lib/tools/recall.ts`

`createRecallTool(userId, currentChatId)` — an ai-v6 `tool()` with
`inputSchema: { query: string }`, described so the model calls it when the user
references earlier context ("what did we decide about X", "that tool you
recommended"). Executes
`recallSearch(topK = RECALL_TOOL_TOP_K, useRerank: true, excludeChatId)` and
returns the hits (chat title, date, content).

Added to `ResearcherTools` and to **every** mode's `activeToolsList`
(skip/speed/balanced/quality).

**Gated at execute time on `!userId || !(await isRecallEnabled(userId))` before
any retrieval** — applying feature A's I-1 lesson directly, so a disabled toggle
means genuinely inert rather than "inert except the tool".

### 7. Library search — hybrid, with a keyword floor

`searchUserChats` delegates to `recallSearch(topK = 20, useRerank: true)` and
maps the hits onto the existing `ChatSearchResult` shape
(`{ chatId, chatTitle, snippet, role, lastViewedAt }`), so the Library UI needs
minimal change.

**Falls back to today's `ILIKE` path when recall is disabled or the index is
empty** — the user's own search box must never break because of a memory
setting.

Deliberate scope call: the recall toggle governs **indexing, auto-injection, and
the tool**. It does *not* remove the user's ability to search their own chats;
with recall off the box degrades to keyword as the index goes stale.

## 8. User control (UI)

**Hard requirement for every surface below: each control must actually do what
it appears to do.** No decorative affordances, no fake progress, nothing that
looks functional but is not.

### a) Attribution chips in answers

`execute` writes `{ type: 'data-recall', id: 'recall', data: { chats: [{ chatId,
title }] } }` **only when recall actually injected**. Rendered through the
existing indicator pattern — a `RecallSection` component (mirroring
`classifier-section.tsx`), an `isRecallPart` type guard alongside
`isClassifierPart`/`isAttachmentsPart`, and a `part.type === 'data-recall'` case
in `render-message.tsx`'s part switch.

Chips read `Recalled from: <chat title>` and **link to `/search/<chatId>`** — a
real navigation. No hits ⇒ no part ⇒ no chip.

This is feasible here precisely where feature A's indicator was not: recall runs
at turn start inside `execute` (writer available), whereas feature A's
extraction runs post-finish in `onFinish`, which the AI SDK gives no writer.

### b) Recall tool-step rendering

A `RecallToolSection` renderer for `tool-recall` invocations — "Searched your
past conversations → N results", expandable to the hits (title · date ·
snippet), each linking through to its chat. Mirrors how search-tool invocations
already render.

### c) Settings → Memory tab

The tab is split into two labelled groups so the toggles are unambiguous:

- **Facts** (feature A) — the existing toggle + memory list.
- **Conversation recall** (feature B) — new toggle bound to
  `user_settings.recall_enabled`; **real index status** ("N chunks across M
  chats", counted server-side); **Rebuild index**; **Clear index** (behind an
  `AlertDialog`, deletes the user's chunks).

A full rebuild can take minutes — too long to block a server action. So
**Rebuild** kicks the backfill off and the panel **polls the real chunk count**,
showing progress from actual rows ("Indexing… 340/760"). Not a spinner that
resolves on a timer.

### d) Library search

Same box, genuinely better results. **No "AI"/"semantic" badge**: the search
silently degrades to keyword when the index is empty or recall is off, so a
badge would be lying in exactly the case where it matters.

## Data flow (one turn, recall enabled)

```
turn starts
  └─ classifier resolves standaloneQuery
  └─ execute: getRecallInjection(userId, standaloneQuery, chatId)
       ├─ embed → pgvector top-N (exclude current chat) → minScore gate
       ├─ hits? → writer.write(data-recall)  → attribution chips
       └─ recallBlock → researcher({ …, recallBlock })  [+ feature A memory block]
  └─ researcher answers (may call the `recall` tool for a deeper dig:
       vector ∪ keyword → cross-encoder rerank → top-K)
  └─ turn finishes → ASYNC (non-blocking, alongside feature A extraction):
       indexMessage(user message) + indexMessage(assistant answer)
         → splitText(512/128) → embed → replace chunks for that message_id

[chat deleted] → FK cascade removes its chunks
[cron/rebuild] → backfillUser: index any message lacking chunks (idempotent)
```

## Config (env)

| var | default | effect |
|---|---|---|
| `RECALL_ENABLED` | on | global kill switch (only `'off'` disables) |
| `RECALL_INJECT_TOP_K` | `2` | auto-injected snippets per turn |
| `RECALL_INJECT_MIN_SCORE` | `0.75` | cosine gate for auto-injection |
| `RECALL_TOOL_TOP_K` | `5` | results returned by the recall tool |
| `RECALL_CHUNK_TOKENS` | `512` | `splitText` maxTokens (matches the embedder window) |
| `RECALL_CHUNK_OVERLAP` | `128` | `splitText` overlap |

Per-user `user_settings.recall_enabled` (new column, default true) gates each
user independently; `RECALL_ENABLED` is the global switch. Reuses
`MEMORY_CRON_SECRET` for the backfill route.

**Inherited hard requirement:** `EMBEDDING_MODEL=mixedbread-ai/mxbai-embed-large-v1`
(1024-d). `conversation_chunks.embedding` is pinned to `vector(1024)`; a
different model's dimension makes every write fail. The loud dimension guard
from feature A applies here too.

## Error handling / fail-safe

- Indexing is async and never blocks a response; failure ⇒ no index change.
- Injection failure ⇒ no block injected, the turn proceeds normally.
- Recall tool failure ⇒ empty result, the turn proceeds.
- **Cross-encoder down ⇒ skip rerank, keep vector order** (matches upload-rag
  and the search pipeline today).
- Library search ⇒ falls back to `ILIKE`.
- Recall disabled (global env or per-user) ⇒ fully inert: no indexing, no
  injection, no tool.
- Embedding dimension mismatch ⇒ loud error, writes skipped.

## Testing

Unit (Vitest):
- Chunking + **idempotent re-index** (re-indexing a message replaces, never
  duplicates).
- `recallSearch`: arm union + dedup by chunk id; `minScore` filter;
  `excludeChatId` honored; rerank optional; graceful when the cross-encoder is
  unconfigured.
- Injection block formatting; no hits ⇒ `''` ⇒ no `data-recall` part.
- Recall tool kill-switch gate (no `userId` / disabled ⇒ inert, no retrieval).
- Library hybrid falls back to `ILIKE` when the index is empty/disabled.
- **SQL-generation assertions** — compiled SQL for the vector and keyword
  queries: no `ANY((…))` row-tuple form, correct `::vector` casts.

Live (staging → prod, standard flow). Mocked tests structurally cannot catch
SQL-generation or real-embedding defects — that is exactly how feature A's
`setLastUsed` bug hid — so these are required, not optional:
- Backfill over real history: counts land, chunks have `dim=1024`.
- "What did we decide about X" ⇒ recall injects, chips render and link
  correctly.
- Explicit tool path ("search our past chats about Y").
- Toggle off ⇒ index frozen, no injection, no tool.
- **Delete a chat ⇒ its chunks cascade away** (privacy).
- Library search finds semantically ("backups" → the 3-2-1 chat).
- Cross-encoder down ⇒ recall still returns results.

## Deployment

- Migration `0017`: `conversation_chunks` (+ HNSW, btree, RLS) and
  `user_settings.recall_enabled`. pgvector is already live in prod from feature
  A, so no image swap is needed this time.
- After deploy, run the backfill once (route or the settings Rebuild control) to
  index existing history.
- Feature inert unless `RECALL_ENABLED` (default on) and the per-user toggle.

## Out of scope (future)

- Re-embedding on `EMBEDDING_MODEL` change (same as feature A).
- Summarizing or compressing old chats to shrink the index (not needed at
  personal scale — ~760 chunks ≈ 3MB today).
- Recall across *other users'* or shared/public chats — strictly per-user.
- Classifier-side recall gating (v1 gates on `minScore`, not on a classifier
  signal).
- Indexing non-text parts (reasoning, sources, files) — text parts only in v1.
