# Feature B ship + hardening — session report

**Date:** 2026-07-17
**Branch:** `admin-feature` → merged to `dev` (dev IS production)
**Scope:** finish conversation recall (feature B), ship it, then fix every bug that
surfaced. No new features.

---

## 1. What shipped to production

| commit    | what                                                         |
| --------- | ------------------------------------------------------------ |
| `8d92840` | recall: make failures visible; correct a wrong perf comment  |
| `57bbc90` | recall: cap the cross-encoder pool at 20 candidates          |
| `2fd240f` | recall: surface attribution chips above the answer           |
| `799bf3c` | ui: keep the sidebar toggle visible when the sidebar is open |
| `1d078f4` | recall: don't drop an answer when a tool call trails it      |
| `523ad46` | security: cron maintenance routes must fail closed, not open |
| `1a208de` | title: don't store an answer as the chat title               |
| `bc50fc5` | chore: make the pre-PR gate green                            |

Plus the whole of feature B (32 commits) merged in `3cdd66b`.

Production DB operations performed (all with a 12M `pg_dump` taken first):

- `REINDEX DATABASE CONCURRENTLY morphic`
- `UPDATE pg_database SET datcollversion = ...` (record the collation version)
- recall backfill ×3 (944 chunks across 5 users)
- repaired 4 corrupted chat titles

---

## 2. Bugs found and fixed

### 2.1 `messages_pkey` was corrupt on production (pre-existing, most serious)

**Symptom:** 22 of 386 messages were invisible to their own primary key.

```
Index Only Scan using messages_pkey  →  actual rows=0     ← row not found
Seq Scan (index disabled)            →  actual rows=1     ← row is right there
```

**Cause:** glibc collation drift. The index held _all_ 386 entries and there were
no duplicates — it was **sorted** under a different collation than the one
comparisons now use, so equality lookups binary-searched down the wrong branch.
`datcollversion` was NULL (the column only exists from PG15; a cluster
originating on ≤14 carries NULL forever), so Postgres never warned.

**Impact:** any lookup of those 22 rows by id silently returned nothing.
`upsertMessage` uses `ON CONFLICT` on that index, so it could have inserted
duplicates (checked: 0 duplicates, no damage). The recall backfill skipped them.

**Fix:** `REINDEX DATABASE CONCURRENTLY morphic`. Verified 22 → 0, and the
originally-failing lookup now returns the row through the index.

**Not caused by our code.** Only found because backfill counts didn't reconcile
(386 total vs 373 attempted vs 355 chunked).

### 2.2 Collation drift had no early warning

`ALTER DATABASE ... REFRESH COLLATION VERSION` errored with
`invalid collation version change` (`dbcommands.c:2557`) — Postgres refuses a
NULL→non-NULL transition, so the supported command could never populate it.

**Fix:** recorded the true version via catalog update (accurate: every index had
just been rebuilt under glibc 2.36). **Proved the warning now fires** by
temporarily recording a stale version:

```
WARNING:  database "morphic" has a collation version mismatch
HINT:  Rebuild all objects in this database that use the default collation...
```

then restored the true value. The exact failure that caused §2.1 will now
announce itself.

### 2.3 Cron maintenance routes were unauthenticated in production

Both `/api/memory/consolidate` and `/api/memory/recall-backfill` guarded with:

```ts
if (secret && request.headers.get('authorization') !== `Bearer ${secret}`)
  return 401
```

which **fails open**: `MEMORY_CRON_SECRET` was never set in prod, so the
condition short-circuited and both routes ran for anyone. Each re-embeds or
rewrites _every user's_ entire history. This session's prod backfills were
triggered by plain unauthenticated `curl` — that is how it was discovered.

**Fix:** one `requireCronSecret()` helper that refuses (503) when the secret is
unset, and compares in constant time via SHA-256 digests. Secret generated and
set in `.env` (gitignored) for prod + staging. 7 tests, including the
fail-closed case.

### 2.4 An entire answer could be stored as the chat title

The title model is handed the user's first message verbatim as its prompt, and
that message usually _is_ a question — so the model sometimes answers it instead
of titling it. `generateChatTitle` had no length check, `updateChatTitle` had no
cap, `chats.title` is unbounded `text`.

**Found in live prod data:** 4 of 79 chats titled with entire answers, longest
**4,832 chars** (normal titles there max out at 54), rendering into the sidebar,
library, and recall chips.

**Fix:** take the first non-empty line (a model that titles then keeps talking
still gave a usable line 1); fall back if the result exceeds 100 chars. It
deliberately does _not_ truncate a runaway answer into a "title" — the first 100
chars of prose isn't a title either, whereas the existing fallback (the user's
own opening words) is genuinely good. `updateChatTitle` caps at 255 as a
backstop for every caller. The 4 prod rows were repaired to the same fallback;
longest title is now 75 chars.

### 2.5 Answers were dropped from the recall index when a tool call trailed them

`extractIndexableText` indexed only text after the **last** tool part (to strip
inter-step narration). But the generative-UI `tool-dynamic` (follow-up
questions) is emitted _after_ the answer, so slicing from the last tool left
nothing and the whole answer indexed as `""`.

**Found in live prod data:** message `aey8…` / "Capital of Japan", 2,498 chars,
unindexed.

**Fix:** position alone can't solve it — "narration → tool → no answer" and
"answer → trailing tool" both end in a tool part (an existing test caught the
naive fix regressing the first). Resolved with the **First-token rule** the
prompts already enforce and `render-message.tsx` already relies on: the final
answer starts with a markdown heading. The fallback only fires when no text
follows the last tool, so every existing path is untouched. Verified against the
real prod parts: 0 → 2,113 chars.

### 2.6 Recall failures were invisible by construction

`recallSearch`'s catch logged only under `NODE_ENV === 'development'`; in
production it could throw every turn and look identical to "no relevant
history". `getRecallInjection`'s catch was fully silent. This is the same shape
as feature A's `setLastUsed` bug. Now logged unconditionally, including the
fail-closed path.

### 2.7 Recall reranked ~60 passages on every turn (~7.6s)

The doc comment claimed "~150ms" — measured with 3 passages, not this path. Both
arms return up to `max(topK*3, 30)`, so a turn reranked up to ~60: **7.6s against
a 10s timeout**, 2.4s from failing closed.

**Fix:** cap the rerank pool at 20 (`RECALL_RERANK_POOL`). Measured on the live
P4000: 20 → 1.33s vs 60 → 4.31s (~3.2×).

The cap is **not** "top N of the union by score": keyword-only hits carry score
`0` by construction, so any top-N cut drops all of them once the vector arm fills
N — which is always. That would have silently reduced the hybrid to its vector
arm with nothing failing. The vector arm fills the pool by cosine rank minus up
to 5 slots reserved for keyword-only hits. A test pins this exact regression.

### 2.8 The sidebar toggle vanished when the sidebar was open

Gated on `(!open || isMobileSidebar)`, so on desktop the button only rendered
while collapsed, leaving `SidebarRail` (a thin invisible strip) as the only way
to collapse it. `SidebarTrigger` already swaps to a filled icon when open — that
branch was dead code on desktop, good evidence the gate was a bug.

### 2.9 Attribution chips were buried in a collapsed section

The chips render "this answer was shaped by these past chats" — but they were
buffered into the research-process accordion, collapsed by default, so
attribution was invisible unless expanded. They now render above the answer.
(This is also what cost hours of debugging — see §4.)

### 2.10 Pre-PR gate was red

`lint` had 1 error (mine); `format:check` failed on 31 files (30 pre-existing).
Two were drizzle-kit _generated_ output — not hand-formatted, since the
generator would rewrite them and re-break the gate; `.prettierignore` already
meant to exclude them but its entry (`lib/db/migrations/`) is a path that no
longer exists, while drizzle writes to `./drizzle`. Added `drizzle/`.

---

## 3. Investigated, not a code defect

### ~31% "invalid citations" from the eval

Real, but **model non-compliance**, not a bug:

| eval run | citations | invalid                        |
| -------- | --------- | ------------------------------ |
| 04-52    | 76        | 0 (0%)                         |
| 04-57    | 118       | 0 (0%)                         |
| 05-20    | 162       | 7 (4.3%)                       |
| 05-50    | 259       | 81 (31.3%), 2 runs at 0% valid |

In the worst run, minimax cited `I8NzFUKwrKX88107` / `aHvy9Vt17r3VSmnG` 36 times
while the real tool-call ids were UUIDs. Those anchors appear **nowhere** in the
stored turn (not in `provider_metadata`, not in any tool-call id, not in the
search output) — so they were fabricated, not provider ids our stack replaced.

The app already: passes the real `toolCallId` in the tool output, explicitly
forbids inventing anchors in the prompt, and **silently drops** unresolvable
citations rather than rendering broken links. Valid citations render correctly as
domain-labeled source links (verified: `postgresql` →
`postgresql.org/docs/release/18.4`).

**Consequence:** affected answers lose inline attribution (correct text, no
sources). A real fix means redesigning the citation scheme to global numbering —
a feature, explicitly out of scope. **Reported, not redesigned.**

---

## 4. Process failures worth recording

- **Hours were burned on a bug that did not exist.** The recall chips rendered
  fine; they were inside a collapsed accordion. I reported "no chips" repeatedly
  from the collapsed view, and once claimed to have expanded it when the click
  had not landed. That single unverified observation drove three confident, wrong
  diagnoses: timeout (disproven by my own measurement), concurrent eval load
  (disproven with the eval dead), wrong user (disproven by the trace).
- **Two near-miss bogus measurements**: scoring 240 psql-split _lines_ as if they
  were 14 chunks; a self-join the planner turned into a hash anti-join that never
  touched the index ("0 invisible rows" — wrong).
- **A merge that silently produced broken code**: git auto-merged an amended
  commit keeping _both_ an import and the old `export const`, no conflict
  markers.
- **A "successful" merge that never happened**: `git checkout dev` aborted, so
  `git merge admin-feature` ran on admin-feature and said "Already up to date."
- **`bun run build` catches what tests don't**: 638 tests + typecheck passed
  while the production build was broken (`export const` in a `'use server'`
  file).
- **`bun format` reformatted 32 unrelated files** as a side effect; reverted.

The recurring lesson: **verify against reality, and watch a test fail before
trusting it.** Every real bug in §2 was found in live data or by numbers that
didn't reconcile — none by unit tests.

---

## 5. Verification

### Gates (all green on `dev`)

```
typecheck     clean
lint          0 errors (4 pre-existing warnings: <img>, exhaustive-deps)
format:check  clean
build         docker image builds
tests         638 passed | 1 skipped
```

### Production state

```
chats 79 | messages 386 | chunks 944 (378/386 messages indexed)
messages invisible to index: 0/386   (was 22)
titles over 255 chars: 0             (was 4, longest 4,832)
messages with real text unindexed: 0 (was 6)
data-recall parts in DB: 0           (C-1 privacy leak — cannot leak via share)
datcollversion: 2.36                 (was NULL — no drift warning possible)
RLS on conversation_chunks: enabled, users_manage_own_conversation_chunks
FK cascade chat_id/message_id: both 'c' (deleted chats lose their chunks)
```

### UI sweep (staging, every surface exercised)

| feature                               | result                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Routes `/`, `/discover`, `/library`   | 200                                                                                                   |
| Composer, weather widget, sidebar nav | pass                                                                                                  |
| Sidebar toggle                        | visible both states, round-trips, clear of panel (x=96 vs 79)                                         |
| Settings — 4 tabs                     | pass                                                                                                  |
| Memory: recall toggle                 | persists both ways (DB verified), genuinely disables recall                                           |
| Memory: index status                  | **real** — UI "181 chunks / 30 chats" == DB exactly                                                   |
| Memory: Clear index                   | confirm dialog; Cancel destroys nothing; Clear scoped to user; other users' chunks + all chats intact |
| Memory: Rebuild index                 | real polling, Clear disabled during, completes, UI "183/31" == DB                                     |
| Chat flow, streaming, title           | pass — title short and correct                                                                        |
| Recall chips                          | visible without expanding, link to source chat                                                        |
| Recall OFF                            | no chips, no injection (kill-switch works)                                                            |
| Library search                        | hybrid/semantic — "rust async runtime" finds chats without those words                                |
| Discover                              | live articles                                                                                         |
| Model selector / search modes         | 8 models; Speed/Balanced/Quality                                                                      |
| Delete response                       | confirm; removes Q+A; **chunks cascade**; chat remains                                                |
| Delete chat                           | confirm; chat+messages+chunks all gone; redirects home                                                |
| Retry                                 | genuinely re-runs the turn                                                                            |
| Citations                             | valid ones render as domain-labeled source links                                                      |
| **Recall on production**              | **works** — "Recalled from: Proxmox Home Server Setup"                                                |

The prod test chat was deleted afterwards; prod is back to exactly 79 chats /
944 chunks.

Not exercised: file-upload flow (input present), keyboard shortcuts, copy/
feedback buttons, Personalization/Models settings tabs, share (disabled by env
on both instances — no `ENABLE_SHARE`).

---

## 6. Still open

- **Citation fabrication** (§3) — needs a citation-scheme redesign; out of scope.
- **`RECALL_INJECT_MIN_SCORE` / pool constants** are env-tunable but undocumented
  in `.env.local.example` beyond the recall block.
- The `recall` tool stays in the model's tool list when a user disables recall;
  it returns empty (the kill-switch gates the tool itself, per feature A's I-1).
  Present-but-inert, because building the list needs an async DB read. Minor: the
  model can waste a step calling it.
- 4 pre-existing lint warnings (`<img>` → `next/image`, one exhaustive-deps).
