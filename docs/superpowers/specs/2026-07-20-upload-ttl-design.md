# Upload TTL (chat-idle expiry) — Design

**Goal:** Automatically delete uploaded files once the chat they belong to
has gone idle for a configurable period (default 14 days), to bound disk
growth on the uploads volume and avoid retaining user files indefinitely —
while degrading gracefully so expiry never breaks a chat or hallucinates
content.

**Status:** Approved design. Branch `admin-feature`. Builds on the universal
uploads feature (`docs/superpowers/specs/2026-07-19-universal-uploads-design.md`,
shipped to prod 2026-07-20).

---

## Motivation

An uploaded file's footprint is three artifacts:

- the original bytes at `uploads/<userId>/chats/<chatId>/<ts>-<name>`,
- a colocated `<...>.chunks.json` sidecar (embeddings of the extracted text —
  `chunksFilePath()` in `lib/embeddings/upload-rag.ts`), which is what powers
  every future answer about the file, and
- a `files` DB row.

There is **no Postgres chunk table** — the chunks live on disk next to the
file, so removing the two disk files is the entire cleanup. Nothing today
ever removes any of it. Large media (2 GB video/audio, scans) accumulates on
the uploads volume of the app host (`.231`, no separate object store), and
files are retained forever regardless of whether anyone will look at them
again.

Two existing behaviors make expiry safe and cheap:

- **Graceful degradation already exists.** `transformFileParts`
  (`lib/streaming/helpers/transform-file-parts.ts`) checks `fileExists` and,
  when the file is gone, injects a plain note instead of erroring — so a
  historical chat whose attachment was deleted keeps working.
- **Deletion is local.** The uploads volume is mounted in the app container,
  so a sweep running in the app has direct `fs` access to unlink bytes and
  sidecars.

---

## Design decisions (settled)

1. **Clock = chat idleness.** A file expires `UPLOAD_TTL_DAYS` after its
   chat's *last activity*, not from upload time and not from per-file access.
   This matches the per-chat-attachment model: attachments live and die with
   the conversation. Re-opening a chat to re-read it keeps its files alive.
2. **Default 14 days**, env-overridable. `0` or unset disables expiry (the
   sweep no-ops) — an explicit opt-out.
3. **Expire everything, gracefully.** Delete the original bytes *and* the
   `.chunks.json` sidecar; keep a lightweight tombstone row
   (`status='expired'`) so the model and UI can say specifically that the
   file expired and prompt a re-upload — rather than a generic "unavailable."

---

## The expiry clock

**Chat last-activity** is the most-recent of three signals (all already
present — `chats` has `id, created_at, title, user_id, visibility,
last_viewed_at`; `messages` has `created_at`):

```
chatLastActivity(chatId) =
  GREATEST( chats.last_viewed_at,          -- bumped when the chat is opened
            chats.created_at,              -- never null; floor
            max(messages.created_at) )     -- last message in the chat
```

Postgres `GREATEST` ignores NULL arguments (returns NULL only if all are
NULL), and `created_at` is never NULL, so a never-viewed / never-messaged
chat correctly falls back to `created_at`.

A file is **expirable** when:

```
status <> 'expired'
AND now() - chatLastActivity(chatId) > (UPLOAD_TTL_DAYS || ' days')::interval
```

with `UPLOAD_TTL_DAYS > 0`.

### Mapping a file to its chat

`files.chat_id` is stored **NULL** by design (a file can be uploaded on the
home screen before the chat row exists — an FK safety measure in the upload
route). The chat id is, however, reliably present in the object key, which
the client mints up front: `object_key = <userId>/chats/<chatId>/<ts>-<name>`
→ `split_part(object_key, '/', 3)` is the chat id (userId, chatId, and the
sanitized filename never contain `/`).

Verified: `components/chat.tsx` seeds `chatId` from `generateId()` on mount
(`useState(() => providedId || generateId())`) and `components/chat-panel.tsx`
sends it as the `x-chat-id` header on every upload, so the object key carries
the real chat id even for a first, pre-message upload — and the chat row is
later created with that same id. So the `created_at` fallback below is a rare
edge, not the common path.

**Approach:** the sweep derives the chat id from `object_key` and joins to
`chats`. No schema change and no change to the message-save path.

- If the derived chat id is `none` or names a chat that no longer exists
  (headerless upload, or the chat was deleted), fall back to aging the file
  by its own `created_at` against the same TTL. (A deleted chat means the
  file is orphaned anyway; a `none` file was never tied to a conversation.)

**Rejected alternative:** backfilling `files.chat_id` on message-save (a real
FK column, indexable). Cleaner in the abstract, but it requires touching the
message-persistence path and a data migration, and buys nothing the
`object_key` parse doesn't already give us for a once-a-day sweep over a
modest row count. Revisit only if the sweep becomes a performance concern.

---

## What expiry does

For each expirable file the sweep:

1. Unlinks the original bytes (`<UPLOADS_DIR>/<object_key>`) and the sidecar
   (`<...>.chunks.json`). Missing-file unlinks are ignored (idempotent).
2. `UPDATE files SET status='expired', ingest_stage=NULL, updated_at=now()`.
   The row is kept as a tombstone; `filename` and `object_key` remain so the
   UI and the answer path can still name the file.

`status` is a plain `character varying` today (values `pending`/`processing`/
`ready`/`failed` are app-level, not a DB enum — the plan must confirm no
`pgEnum`/CHECK constraint; if one exists, add `expired` via a migration).
Reusing `status` avoids a new column; `updated_at` records when expiry
happened.

### In-flight protection

Skip files that are actively being ingested: `status='processing' AND
claimed_at > now() - interval '30 minutes'`. Ingestion completes in
seconds-to-minutes and the TTL is days, so this only guards against the
vanishingly rare case of a chat idling out mid-ingest; it never deletes bytes
out from under the worker.

---

## Graceful degradation

**Answer-time (model-facing).** `transformFileParts` already branches on the
`findFileByObjectKey` status. Add an `expired` branch that returns:

```
[Attached file: <name> — this upload expired after <N> days of chat
inactivity and is no longer available. Tell the user to re-upload it to ask
about it again.]
```

This runs *before* the `fileExists` check, so the message is specific
("expired, re-upload") rather than the generic "no longer available" the
missing-bytes path would produce. The vision-model image branch is likewise
gated: an expired image has no bytes to attach, so it too yields the
re-upload note.

**Compose-time chips.** `/api/files/status` +
`components/uploaded-file-list.tsx` already poll and render per-file status.
Add an `expired` chip state ("Expired — re-upload to use again"). Because the
tombstone row persists, the status endpoint keeps returning the file with
`status='expired'`.

**Historical message previews (should-have).** A file part rendered in an old
message loads its preview from the file URL, which now 404s. The
image/file-attachment renderer should catch the load failure and show the
same "Expired — re-upload" placeholder instead of a broken image. If this
proves fiddly it can ship as a fast-follow; the model-facing note and the
compose chip are the required parts.

---

## The sweep

**Core.** A `expireIdleUploads()` action in `lib/db/file-actions.ts`
(alongside the existing job-state actions), runnable and unit-testable in
isolation. It:

1. Selects expirable files with the `object_key`→`chats` join and the
   activity formula above (plus the `none`/missing-chat `created_at`
   fallback), excluding `status='expired'` and in-flight rows.
2. For each, unlinks bytes + sidecar, then sets the tombstone.
3. Performs orphan GC (below).
4. Returns a summary `{ expired, bytesFreed, orphansRemoved }` and logs it.

It runs as a **system job** — bypassing per-user RLS the same way the ingest
job-state actions do (this is a cross-user maintenance task, not a
user-scoped query).

**Trigger.** A token-authed route `POST /api/maintenance/expire-uploads`,
authorized with the existing internal token via the `checkIngestAuth`-style
helper (`lib/utils/ingest-auth.ts`: 503 when unset, constant-time compare,
401 on mismatch — reused, not duplicated). Reusing `INGEST_API_TOKEN` keeps
config minimal; both are trusted-internal-caller auth. The route calls
`expireIdleUploads()` and returns the summary.

Driven by a **daily cron** on `.231` hitting the route:

```
15 4 * * *  curl -fsS -X POST http://localhost:3738/api/maintenance/expire-uploads \
              -H "Authorization: Bearer $INGEST_API_TOKEN" >/dev/null
```

Route + external cron (over an in-app `setInterval`) because it is testable
on demand with a curl, observable via the route's logged summary, and matches
the existing pattern where the app is driven by external callers holding the
internal token. An in-app daily interval is a viable zero-cron alternative if
preferred; noted, not chosen.

**Orphan GC (cheap, same pass).**

- A `files` row whose bytes are already missing and whose chat is idle past
  TTL → mark `expired` (reconciles rows left by manual deletes).
- An on-disk file or `.chunks.json` with no matching `files` row and older
  than the TTL → unlink. Match strictly by `object_key` to avoid deleting a
  live file; skip anything ambiguous.

---

## Configuration

- `UPLOAD_TTL_DAYS` (integer, default `14`; `0`/unset ⇒ expiry disabled).
- Added to the model-manager env registry (`selfhosted/model-manager`) so it
  is tunable from the admin UI. Registry changes require a manual
  model-manager container redeploy (per the model-manager deploy notes) —
  called out so it isn't missed.

---

## Edge cases

- **TTL disabled (`0`/unset):** the sweep returns immediately with a zeroed
  summary; nothing is deleted.
- **Chat deleted, files remain:** derived chat id has no `chats` row → aged by
  the file's `created_at`; expires and its bytes are reclaimed.
- **`chats/none` files:** never tied to a conversation → aged by `created_at`.
- **Re-run idempotency:** `status='expired'` rows are excluded from selection;
  missing-file unlinks are ignored, so repeated sweeps are no-ops.
- **A user re-uploads after expiry:** a brand-new file row + object key +
  bytes; the tombstone is unrelated and untouched.
- **Fast-path text files:** identical treatment (they are ordinary files with
  a chat and a sidecar); no special case.

---

## Testing

Vitest (`bun run test`), alongside the existing uploads tests.

- **`expireIdleUploads` unit tests** (mocked DB + `fs`): files across chat
  ages → correct expire/keep decisions; the TTL boundary (just under vs just
  over); `last_viewed_at` NULL falling back to `created_at`; a newer message
  keeping an old-`created_at` chat alive; bytes + sidecar unlinked; tombstone
  set; already-`expired` skipped; in-flight `processing` skipped; the
  `none`/deleted-chat `created_at` fallback; `UPLOAD_TTL_DAYS=0` disables.
- **`transformFileParts`:** an `expired` row → the re-upload note (and never
  reads bytes/chunks); the expired-image case yields the note, not a base64
  attach.
- **Route:** token auth (503 unset / 401 wrong / authed happy path) and the
  returned summary shape.
- **Orphan GC:** a row with missing bytes → expired; a stray sidecar with no
  row → unlinked; a live file → untouched.
- **Staging E2E (`:3739`):** upload a file, backdate its chat's
  `last_viewed_at` and messages past the TTL, POST the sweep route, confirm
  bytes + sidecar are gone and the row is `expired`, then ask a follow-up and
  confirm the answer reports the file expired and asks for a re-upload.

---

## Out of scope

- Two-tier expiry (dropping heavy originals earlier than chunks) — considered
  and set aside for a single, predictable TTL.
- Per-user quotas / size-based LRU eviction — a possible complementary hard
  cap later; this feature is time-based only.
- Backfilling `files.chat_id` and any change to the message-save path.
- A UI control for TTL beyond the model-manager env field.

---

## Files touched (overview — the plan will make this exact)

- `lib/db/file-actions.ts` — `expireIdleUploads()` + orphan GC.
- `lib/streaming/helpers/transform-file-parts.ts` — `expired` branch.
- `app/api/maintenance/expire-uploads/route.ts` — token-authed trigger (new).
- `app/api/files/status/route.ts` + `components/uploaded-file-list.tsx` —
  `expired` chip state.
- Attachment/message file-part renderer — expired preview placeholder
  (should-have).
- `selfhosted/model-manager` env registry — `UPLOAD_TTL_DAYS`.
- Deployment: the daily cron entry on `.231`.
- Possibly a migration only if `status` turns out to be a DB enum.
