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

- **Feature A** answers _who you are_ — a small, curated set (~30 facts),
  injected on every turn.
- **Feature B** answers _what we already discussed_ — the actual conversation
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

| column        | type           | notes                                     |
| ------------- | -------------- | ----------------------------------------- |
| `id`          | varchar (cuid) | PK                                        |
| `user_id`     | varchar(255)   | RLS key                                   |
| `chat_id`     | varchar        | **FK → `chats.id`, ON DELETE CASCADE**    |
| `message_id`  | varchar        | **FK → `messages.id`, ON DELETE CASCADE** |
| `role`        | varchar enum   | `user` \| `assistant`                     |
| `content`     | text           | the chunk text                            |
| `chunk_index` | integer        | position within the message               |
| `embedding`   | `vector(1024)` | mxbai (`EMBEDDING_MODEL`)                 |
| `created_at`  | timestamp      | mirrors the message's date (recency)      |

- RLS policy `users_manage_own_conversation_chunks` using
  `user_id = (select current_setting('app.current_user_id', true))` — mirrors
  `user_memories`.
- Indexes: HNSW on `embedding` (`vector_cosine_ops`); btree on `user_id`,
  `chat_id`, `message_id`.

**DB action layer** — `lib/db/recall-actions.ts`, mirroring
`lib/db/memory-actions.ts` (every operation through `withOptionalRLS(userId, …)`
_and_ an explicit `user_id` predicate, per the established defence-in-depth
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
its source chat. Chunks are the opposite: they are _derived copies of message
text_. If a chat (or a message) is deleted and its chunks survive, the model
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
_cosine similarity_ when `useRerank` is false, and _cross-encoder score_ when
rerank ran; step 5 overwrites it. `minScore` is a gate on **whatever scale
`score` currently is**, so it is only meaningful alongside a known `useRerank`
setting.

> **Amended 2026-07-16 after the live staging E2E.** This section originally
> paired `minScore` with `useRerank: false` and called it "unambiguously a
> cosine gate." **Measurement proved cosine is unusable as a relevance gate
> here** — see §5. Both gating callers now use `useRerank: true`, so in practice
> `minScore` is always a **cross-encoder-scale** threshold. Recorded rather than
> quietly rewritten, because the original reasoning looked sound and was wrong.

**Fail closed on a scale mismatch.** If `useRerank: true` is requested _with_ a
`minScore` but rerank cannot actually run (cross-encoder unconfigured, or it
threw), the hits still carry **cosine** scores — and comparing a rerank-scale
threshold (~0.05) against cosine values (~0.6) would pass **everything**. That is
precisely the silent scale mismatch this note exists to prevent, so
`recallSearch` returns `[]` in that case rather than a flood of unfiltered
results. Consequences are deliberate and safe: reranker down ⇒ no auto-injection
(the turn proceeds normally) and the Library's semantic arm drops out (the
keyword arm still carries the box). A caller that passes **no** `minScore` is
unaffected and still degrades to cosine ordering.

The union arm is what makes both cases work: exact proper nouns ("Traefik",
which vector search alone handles poorly) and semantic paraphrase ("backups" →
"3-2-1 rule").

### 5. Auto-injection — into the researcher

Computed **in the streaming `execute`**, not inside `createResearcher`, because
it needs two things that only exist there: the classifier's resolved
`standaloneQuery`, and the `writer` for the attribution part (§8a).

- `getRecallInjection(userId, query, currentChatId)` →
  `recallSearch(topK = RECALL_INJECT_TOP_K, useRerank: true,
excludeChatId: currentChatId, minScore: RECALL_INJECT_MIN_SCORE)`.
- On hits: `execute` writes the `data-recall` part, then passes a `recallBlock`
  string into `researcher({ …, recallBlock })`, which appends it to the system
  prompt alongside feature A's memory block. Block shape:
  `## Relevant past conversations` followed by, per hit,
  `- From "<chat title>" (<date>): <content>`.
- The current chat is excluded — its context is already in the prompt.
- Fail-safe: `''` on any error, and the turn proceeds normally. Reranker
  unavailable ⇒ the gate fails closed (§4) ⇒ no injection, turn unaffected.

> **Amended 2026-07-16 after the live staging E2E — the original design here did
> not work at all.** It specified `useRerank: false` with a **cosine** gate of
> `RECALL_INJECT_MIN_SCORE = 0.90` (later 0.75), justified as: "per-turn cost
> stays a local embed (~50ms) plus an HNSW query with no network hop, so turns
> that need no history pay almost nothing." The E2E measured reality and both
> halves of that reasoning collapsed:
>
> - **The gate was unreachable.** For a genuinely relevant query ("How should I
>   protect my data against ransomware?" against a chat that discussed
>   ransomware, immutability and the 3-2-1 rule) the best real cosine was
>   **0.626** — so a 0.75 gate meant auto-injection could _never_ fire. The
>   feature was silently inert while looking fully implemented.
> - **Cosine cannot discriminate here at all.** Irrelevant chunks scored
>   **0.570** against that same query, and the top-scoring chunk (0.626) was a
>   stray reasoning fragment, not the backup content. A ~0.06-wide band between
>   relevant and irrelevant makes _any_ cosine threshold arbitrary: lower it to
>   0.60 and you inject "I'm a software engineer" (0.622) for a ransomware
>   question.
> - **The cross-encoder discriminates cleanly on the same input:** relevant
>   **0.169** vs irrelevant **0.0000164** — a ~10,000× separation.
> - **The latency the original design optimised for was a rounding error.** The
>   reranker is on the LAN; ~150ms against 30–90s turns is ~0.3%.
>
> Lesson worth keeping: a bi-encoder cosine score is a _ranking_ signal, not a
> calibrated _relevance_ signal. It orders candidates fine; it cannot answer "is
> anything here actually relevant?" Only the cross-encoder can, so only it can
> gate. Thresholds must be measured against real data before being written into
> a spec — 0.90/0.75 were plausible-looking numbers invented at design time.

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

### 7. Library search — a true union of semantic + keyword

> **Amended 2026-07-16 after the whole-branch review.** This section originally
> specified "delegate to `recallSearch(topK = 20, useRerank: true)`, and fall
> back to `ILIKE` when recall is disabled or the index is empty." **That was
> wrong and shipped a real defect** — recorded here rather than quietly
> rewritten, because the failure is instructive.
>
> The vector arm is `ORDER BY embedding <=> q LIMIT 30` with **no distance
> threshold**, and `recallSearch` only applies `minScore` when it is passed —
> which this path deliberately did not pass (rerank was on, and `minScore` is a
> cosine-scale gate). So once the index held ≥1 chunk, **every query returned
> hits**, which made the `ILIKE` "floor" unreachable in practice. Searching
> gibberish returned 20 unrelated chats instead of "No results", and because
> only message _text_ is chunked (never `chats.title`), a chat matching only by
> its **title** — or any not-yet-indexed chat — became invisible. That is a
> regression: the original keyword search matched `chats.title` OR
> `parts.text_text`. The unit test masked it by mocking `recallSearch → []`, a
> state a populated index cannot produce.

`searchUserChats` runs **both arms on every query, concurrently**, and merges:

1. **Keyword arm** — the existing `ILIKE` implementation (`chats.title` OR
   `parts.text_text`), unchanged, still ordered most-recently-viewed first.
2. **Semantic arm** — `recallSearch(topK = 20, useRerank: true,
minScore: RECALL_SEARCH_MIN_SCORE)`, mapped onto the existing
   `ChatSearchResult` shape (`{ chatId, chatTitle, snippet, role, lastViewedAt }`),
   so the Library UI needs no change.
3. **Merge** — keyword results first in their existing order, then semantic hits
   not already present, deduped by `chatId` (a chat found by both keeps the
   keyword row), then `slice(0, limit)`.

Two properties this buys, both load-bearing:

- **Today's results are a strict subset, in today's order.** Semantic hits are
  purely additive, so nothing a user can find today stops being findable —
  including title-only matches.
- **"No results" is honest again.** The function returns `[]` only when _both_
  arms are empty — which requires the semantic arm to be **gated**
  (`RECALL_SEARCH_MIN_SCORE`, on the cross-encoder scale, default `0.01`).
  Without that gate the vector arm returns its nearest 30 chunks for _any_
  input, so the union would always be non-empty.

> **Second amendment, 2026-07-16 — the union alone did not deliver this.** The
> first amendment (above) fixed the unreachable keyword floor but still claimed
> "returns `[]` only when both arms are empty." The live E2E disproved it:
> searching `zzzzqqqxyz` returned **5 unrelated chats**, because the semantic arm
> had no relevance gate and pgvector happily returns the nearest rows regardless
> of distance. "No results" was still impossible. The gate above is what actually
> makes the claim true — and its threshold sits on the reranker's scale
> (gibberish scores ~0.00002; real matches ~0.17), deliberately more permissive
> than injection's `0.05` because a user who typed a query wants candidates,
> whereas injecting noise pollutes the prompt.

The semantic arm is fail-safe: the dynamic import and the `recallSearch` call
are wrapped so any failure (or a disabled/empty index) degrades it to `[]`,
leaving the box behaving exactly as it does today. The user's own search box must
never break because of a memory setting.

Deliberate scope call: the recall toggle governs **indexing, auto-injection, and
the tool**. It does _not_ remove the user's ability to search their own chats;
with recall off the box is simply the keyword arm.

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

**The chips are live-turn-only — they are stripped before persistence and do not
survive a reload.** (Amended 2026-07-16 after the whole-branch review, which
caught this as a Critical privacy leak. Recorded rather than quietly rewritten,
because the failure is instructive.)

The original design persisted the chips like any other part. But
`lib/utils/message-mapping.ts` persists **any** `data-*` part generically, and
`lib/db/schema.ts`'s `public_chat_parts_readable` RLS policy exposes **every**
part of a public chat `TO public`. Since a chip names the user's _other_ chats by
**title and id**, sharing a chat would have disclosed the titles of unrelated
**private** conversations to anonymous visitors — e.g. a chat titled
"Negotiating my severance package" surfacing on a shared, unrelated chat. RLS
still blocked _opening_ those chats, but the title is usually the most sensitive
string. Feature A has no equivalent exposure: it injects a prompt block and never
writes a data part.

The fix is to strip `data-recall` parts before `persistStreamResults` (see
`lib/streaming/helpers/strip-recall-from-message.ts`), so the chips exist only in
the live stream. This is also the more honest design: the chip is a claim about
_this_ generation, not a durable property of the message. The wiring is pinned by
a regression test — the strip is one line standing between a private chat title
and an anonymous visitor, so it must not be removable without a test failing.

**Note for any future `data-*` part:** anything written into a message is
world-readable the moment that chat is shared. Data parts must contain nothing
derived from the user's _other_ chats unless it is stripped before persistence.

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
**Rebuild** runs one bounded slice per call and the client loops until the
backfill reports it has drained, refreshing the **real chunk count** from actual
rows each round. The button reads "Indexing…" for exactly as long as real
indexing is happening — never a spinner on a timer, and no percentage or ETA
(the remaining total isn't known without another query, and faking it would
violate the rule above).

The loop must be structurally incapable of running forever, because "never
throws" and "report status honestly" pull against each other here. Three real
defects were found and fixed in review/E2E, all worth keeping in mind for any
similar control:

- A round that _attempts_ work but indexes nothing (embedding model missing,
  dimension mismatch) means the same rows are re-selected forever — so
  "made progress" must be distinguished from "attempted", and a no-progress
  round must surface an error and stop, plus a hard round cap as a backstop.
- Rebuild is **disabled when the recall toggle is off**; otherwise it can never
  succeed and reports a diagnosis ("check EMBEDDING_MODEL") that blames the
  wrong thing entirely — the actual cause being the toggle directly above it.
- A swallowed backfill error must not become a green "Index is already up to
  date". The backfill reports an explicit `ok` flag; success requires
  `ok && messages === 0`.

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

| var                       | default | effect                                                       |
| ------------------------- | ------- | ------------------------------------------------------------ |
| `RECALL_ENABLED`          | on      | global kill switch (only `'off'` disables)                   |
| `RECALL_INJECT_TOP_K`     | `2`     | auto-injected snippets per turn                              |
| `RECALL_INJECT_MIN_SCORE` | `0.05`  | **cross-encoder** gate for auto-injection                    |
| `RECALL_SEARCH_MIN_SCORE` | `0.01`  | **cross-encoder** gate for the Library search's semantic arm |
| `RECALL_TOOL_TOP_K`       | `5`     | results returned by the recall tool                          |
| `RECALL_CHUNK_TOKENS`     | `512`   | `splitText` maxTokens (matches the embedder window)          |
| `RECALL_CHUNK_OVERLAP`    | `128`   | `splitText` overlap                                          |

**Both `*_MIN_SCORE` values are on the cross-encoder's scale, not cosine**
(amended 2026-07-16 — see §4/§5). Measured on real data: a relevant match scores
**~0.17**, an irrelevant one **~0.00002**, so anything in `0.001`–`0.1`
separates them; injection uses the stricter `0.05` (noise pollutes the prompt)
and Library search the more permissive `0.01` (a user who typed a query wants
candidates). Do **not** reuse a cosine-era value here — `0.75` on this scale
rejects everything, which is precisely the bug that shipped. If the reranker is
unavailable these gates fail closed (no injection; Library degrades to keyword).

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
- Recall across _other users'_ or shared/public chats — strictly per-user.
- Classifier-side recall gating (v1 gates on `minScore`, not on a classifier
  signal).
- Indexing non-text parts (reasoning, sources, files) — text parts only in v1.
