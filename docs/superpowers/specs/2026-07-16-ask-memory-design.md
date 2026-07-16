# Ask Memory (A) — Auto-extracted User Facts & Preferences

**Date:** 2026-07-16
**Status:** Approved (design), pending implementation plan
**Component:** Ask — cross-session per-user memory (pgvector on existing Postgres)

## Goal

Give Ask long-term, per-user memory: it auto-learns durable facts and
preferences about a user across conversations and factors them into future
answers — the ChatGPT/Claude/Perplexity "it just remembers me" experience —
without the user having to restate context. This spec covers **feature A**
(auto-extracted user facts & preferences). Conversation recall / RAG-over-past-
Q&A is **feature B**, a separate follow-on spec on the same pgvector store.

Today Ask has **no cross-session memory** — the classifier only sees the
current chat's last 20 messages; nothing persists across chats.

## How the incumbents do it (design basis)

- **ChatGPT**: an auditable *Saved Memories* list (user-directed + model-
  extracted concise facts) + a background *"Dreaming"* process that
  synthesizes a memory state across many past conversations, injected at chat
  start.
- **Claude**: automatic *synthesis* of a summary of key facts (role,
  preferences, recurring topics) refreshed ~daily, plus immediate user-directed
  saves via a dedicated tool.
- **Perplexity**: retrieval-based memories; **repetition is the salience
  signal** ("ask 3× → filed"); deliberately *fewer, higher-quality* memories
  (their upgrade stored ~half as many while recall rose 77%→95%).

**Four lessons baked into this design:** (1) synthesis/consolidation beats
naive per-turn writes; (2) **salience via repetition** — a fact earns its place
by recurring; (3) **fewer, better** memories; (4) **explicit user-directed
saves are first-class** ("remember that I…").

## Architecture

Six units, each independently testable:

### 1. Storage — `user_memories` (pgvector)

New Drizzle table, RLS-isolated exactly like `chats`:

| column | type | notes |
|---|---|---|
| `id` | varchar (cuid) | PK |
| `user_id` | varchar(255) | RLS key |
| `content` | text | the concise fact ("Self-hosts their infrastructure") |
| `category` | varchar enum | `preference` \| `fact` \| `interest` |
| `status` | varchar enum | `candidate` \| `confirmed` (only `confirmed` is injected) |
| `sightings` | integer | repetition/salience count (default 1) |
| `embedding` | `vector(1024)` | mxbai-embed-large-v1 (the configured `EMBEDDING_MODEL`) |
| `source_chat_id` | varchar, nullable | provenance |
| `created_at` / `updated_at` | timestamp | |
| `last_used_at` | timestamp, nullable | set when injected; drives eviction |

- RLS policy `users_manage_own_memories` using
  `user_id = (select current_setting('app.current_user_id', true))` — mirrors
  the `chats` policy.
- Indexes: HNSW on `embedding` (`vector_cosine_ops`); btree on `user_id` and
  `(user_id, status)`.
- Embeddings reuse the existing local pipeline (`embedTexts` /
  `transformers-embedding`, mxbai 1024-d — same model as upload-RAG). The
  column dimension is pinned to that model; changing `EMBEDDING_MODEL` requires
  re-embedding (documented, out of scope).
- Per-user **on/off** lives in a small `user_settings` table
  (`user_id` PK, `memory_enabled boolean default true`), RLS-isolated.

### 2. Extraction — async, per-turn (granite on serenity)

After the researcher finishes a turn, kick off an **async, non-blocking**
extraction (same pattern as `generateChatTitle` in the streaming pipeline —
fire-and-forget; never delays the response):

- Input: the user's latest message (+ the classifier's resolved
  `standaloneQuery` for reference resolution). Durable facts come from what the
  *user* states, not the assistant's answer.
- Model: **granite4.1:8b on serenity** (the existing structured-output
  classifier host), a new structured-output prompt: *"Extract 0–N durable facts
  about THIS USER worth remembering across conversations — stable preferences,
  identity, recurring interests, constraints. Skip transient query content,
  one-off facts, the assistant's answer, and sensitive PII unless the user
  frames it as a lasting preference. Return a JSON array of {content,
  category}."* Returns `[]` when nothing is worth saving (the common case).
- Fail-safe: any error ⇒ no memory change, zero user impact (like the
  classifier's fallback).

### 3. Write path — dedup, repetition-graduation, supersede, cap

For each extracted candidate (and each `remember`-tool save):

1. Embed the candidate; cosine-search the user's existing memories.
2. **Near-duplicate** (cosine ≥ `MEMORY_SIM_THRESHOLD`, default 0.90): increment
   the existing row's `sightings`, refresh `updated_at`. If the two phrasings
   differ materially, a small granite "merge" call rewrites `content` to the
   better phrasing. If it was a `candidate` and `sightings` now ≥
   `MEMORY_GRADUATE_SIGHTINGS` (default 2), promote to `confirmed` — Perplexity's
   repetition filter.
3. **Contradiction** with an existing `confirmed` memory (granite decides on the
   collision, e.g. new "prefers concise" vs old "prefers detailed"):
   **supersede** — update the existing row's content to the newer fact.
4. **No match**: insert as `candidate` (`sightings=1`). Facts saved via the
   `remember` tool insert directly as `confirmed` (user-directed = immediate,
   like all three incumbents).
5. **Cap + eviction**: if a user's `confirmed` count exceeds
   `MEMORY_MAX_PER_USER` (default 30), evict the least-recently-used
   (`last_used_at` asc, then oldest) — keeps the set small and high-signal.

### 4. `remember` tool — user-directed / model-initiated saves

Add a `remember` tool to the researcher's toolset (alongside
search/fetch/etc.). The model calls it when the user explicitly asks ("remember
that I self-host everything") or when it recognizes a clearly durable
preference mid-turn. It writes a `confirmed` memory immediately through the same
write path (§3 dedup applies). This is the first-class explicit-save mechanism
every incumbent has.

### 5. Consolidation — minimal periodic pass ("Dreaming-lite")

A lightweight scheduled job (cron, default daily) per active user:
re-reads their `confirmed` memories, asks granite to **merge remaining
near-duplicates and resolve any contradictions** (keep newest), and enforces the
cap by LRU eviction. This is the incumbents' background-synthesis idea in
minimal form — the on-write logic (§3) already keeps the set mostly clean, so
this is a coherence sweep, not the primary mechanism. Fuller cross-conversation
re-synthesis is a v1.1 follow-on.

### 6. Retrieval & injection — into the researcher

In `createResearcher` (where `systemInstructions` is appended to the system
prompt), when memory is enabled for the user:

- Fetch the user's `confirmed` memories (small, ≤ cap). Inject as a block:
  `## What you know about this user\n- <content>\n- <content>` — the incumbents'
  "synthesized state at chat start." If the set ever exceeds an injection cap
  (`MEMORY_INJECT_TOP_K`, default = the max cap so normally all are injected),
  take top-K by cosine relevance to the resolved query.
- Set `last_used_at = now()` on the injected rows (usage signal for eviction).
- v1 injects into the **researcher** only; classifier-context injection is a
  v1.1 consideration.

### 7. User control (UI)

A **Memory** settings page: lists the user's memories (confirmed; candidates
optionally shown as "learning"), with **delete individual** / **clear all**, and
a per-user **on/off toggle** (`user_settings.memory_enabled`). Off ⇒ no
extraction, no `remember` tool, no injection — fully inert for that user. Plus a
subtle **"Memory updated"** indicator on a turn when something was saved (a
streamed `data-memory` part, same mechanism as the existing classifier/
attachments indicators).

## Data flow (one turn, memory enabled)

```
turn starts
  └─ createResearcher: fetch confirmed memories → inject into system prompt
                        (set last_used_at) ; researcher has the `remember` tool
       └─ researcher answers (may call `remember` → confirmed memory now)
  └─ turn finishes → ASYNC (non-blocking, like title-gen):
       granite extraction on the user message
         → per candidate: embed → dedup/similarity
             → near-dup: sightings++ ; graduate to confirmed at N
             → contradiction: supersede
             → new: insert candidate
         → cap/evict
  [daily cron] consolidation: merge/resolve/evict per user
```

## Config (env)

| var | default | effect |
|---|---|---|
| `MEMORY_ENABLED` | on | global kill switch (only `'off'` disables) |
| `MEMORY_SIM_THRESHOLD` | `0.90` | dedup cosine cutoff |
| `MEMORY_GRADUATE_SIGHTINGS` | `2` | candidate → confirmed after N sightings |
| `MEMORY_MAX_PER_USER` | `30` | cap; LRU eviction beyond it |
| `MEMORY_INJECT_TOP_K` | `30` | injection cap (≥ max = inject all) |

Per-user `user_settings.memory_enabled` gates each user independently; the env
var is the global switch. Embeddings use the configured `EMBEDDING_MODEL`
(mxbai, 1024-d).

## Error handling / fail-safe

- Extraction / consolidation are async and never block a response; failure ⇒ no
  memory change.
- Injection failure ⇒ no memories injected, the turn proceeds normally.
- Memory disabled (global env or per-user) ⇒ fully inert (no extraction, no
  tool, no injection).
- serenity/granite down ⇒ extraction no-ops (same graceful fallback as the
  classifier).

## Testing

Unit (Vitest):
- Extraction output parsing (valid JSON array; empty when nothing durable).
- Write path: dedup by similarity; `sightings` increment; graduation at the
  threshold; supersede on contradiction; cap/LRU eviction.
- Injection block formatting; `last_used_at` update.
- The `remember` tool writes a `confirmed` memory (dedup applied).
- Toggle off / `MEMORY_ENABLED=off` ⇒ no writes, no injection.

Live (staging → prod, standard flow):
- State a durable preference twice across turns/chats ⇒ it graduates to
  `confirmed` and is injected on the next turn (visible in the answer using it).
- "Remember that I …" ⇒ saved immediately; visible in the settings list.
- Per-user toggle off ⇒ nothing saved or injected.

## Deployment

- Swap the Postgres image to `pgvector/pgvector:pg17`; migration runs
  `CREATE EXTENSION IF NOT EXISTS vector`, creates `user_memories` +
  `user_settings` with RLS + the HNSW index (Drizzle migration).
- Feature inert unless `MEMORY_ENABLED` (default on) — but the pgvector
  extension + tables must exist first, so the migration is the gating step.

## Out of scope (future)

- **Feature B**: conversation recall / RAG over past Q&A (separate spec, same
  store).
- Heavy continuous "Dreaming"-style cross-conversation re-synthesis (v1 ships
  the minimal consolidation sweep).
- Classifier-context injection (v1 injects into the researcher only).
- Re-embedding on `EMBEDDING_MODEL` change; memory export/portability.
