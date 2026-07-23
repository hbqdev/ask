# Upload TTL — Build Report

Chat-idle expiry for uploaded files. Built via subagent-driven development on
branch `admin-feature`. Status: **code complete, final-review "ready to merge",
staging E2E green. Not deployed to prod (awaiting approval).**

Spec: `docs/superpowers/specs/2026-07-20-upload-ttl-design.md`
Plan: `docs/superpowers/plans/2026-07-20-upload-ttl-plan.md`

## What it does

An uploaded file is deleted once the chat it belongs to has been idle for
`UPLOAD_TTL_DAYS` (default 14; `0`/unset disables — opt-in). "Idle" is the
most recent of the chat's `last_viewed_at`, its `created_at`, and its last
message. On expiry the file's bytes and its `.chunks.json` embedding sidecar
are removed and the `files` row is tombstoned `status='expired'`; the answer
path and UI then tell the user the file expired and to re-upload. A
token-authed route runs the sweep, driven by a daily cron.

## Design decisions

- **Clock = chat idleness**, not upload age or per-file access. Re-viewing or
  messaging a chat keeps its attachments alive. Chosen because uploads are
  per-chat attachments.
- **Default 14 days**, env-overridable; `0`/unset disables the sweep entirely.
- **Delete everything, gracefully**: bytes + sidecar removed, a lightweight
  tombstone row kept so the "expired — re-upload" message is specific.

## Commits (`c306187..4a54fab`)

| Commit    | Task | Summary                                                                                                    |
| --------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| `1113de6` | 1    | `expireIdleUploads()` sweep — chat-idle SELECT, unlink bytes+sidecar, tombstone, path-guard, disabled-on-0 |
| `1bd085a` | 2    | orphan GC — reap on-disk files/sidecars with no row, past TTL                                              |
| `ff42d1f` | 3    | token-authed `POST /api/maintenance/expire-uploads`                                                        |
| `b101c99` | 4    | answer-time "expired — re-upload" note (before the vision/base64 branch)                                   |
| `fd79f3c` | 5    | UI expired state — chip + history `onError` placeholder                                                    |
| `8d6be71` | 6    | `UPLOAD_TTL_DAYS` in the model-manager env registry (default 14)                                           |
| `00fe89f` | 6b   | **remove legacy `upload-cleanup.ts`** (see below)                                                          |
| `3b8b088` | —    | `gcOrphanUploads` `days<=0` guard (final-review fix)                                                       |
| `4a54fab` | —    | enable `UPLOAD_TTL_DAYS=14` on the staging compose (test only)                                             |

Status widening (`'expired'` added to the drizzle TS-enum) produced **no DB
migration** — `status` is a plain `varchar(256)` with no CHECK/pgEnum.

## Review findings caught

- **T1 — Critical (fixed):** the sweep defaulted `UPLOAD_TTL_DAYS` to `14`
  when unset, so a deployment that never configured it would silently delete
  files after 14 idle days. Changed to opt-in (`?? 0`); prod sets `14`
  explicitly.
- **T6 — legacy collision (fixed via Task 6b):** a pre-existing
  `lib/utils/upload-cleanup.ts`, wired into `instrumentation.ts`, ran
  `find UPLOADS_DIR -type f -mtime +${UPLOAD_TTL_DAYS||3} -delete` on every
  server start. It has been age-deleting prod uploads older than 3 days,
  bypassing the DB entirely. It read the same env var and would collide with
  the new sweep (age-delete without a tombstone, so the graceful note never
  fires). Removed; the chat-idle sweep is now the sole `UPLOAD_TTL_DAYS`
  consumer. **This changes prod behavior — see "Deploy" below.**
- **T2 — Minor (fixed):** internal `days<=0` guard added to the exported,
  destructive `gcOrphanUploads`.
- Remaining Minors accepted as fast-follows: image-history `onError` is a
  broad trigger (self-heals on refresh); non-image (PDF) expiry has no
  history placeholder (the answer-path note still governs correctness); minor
  cosmetic items. None affect correctness.

## Final whole-branch review

**Ready to merge.** Verified the disable gate short-circuits both the
chat-idle pass and the orphan GC before any DB/disk work; neither pass can
escape `UPLOADS_DIR`; live/in-flight files are protected three ways; the
`object_key → chat` mapping matches the real upload key format; the `expired`
status flows sweep → `transform-file-parts` → status API → UI; and the legacy
path is fully gone.

## Staging E2E (`:3739`, `UPLOAD_TTL_DAYS=14`)

The chat-idle SQL is not unit-testable (mocked DB), so it was validated here
with controlled data. All green:

| Case                     | Setup                              | Expected                                      | Result |
| ------------------------ | ---------------------------------- | --------------------------------------------- | ------ |
| Real upload              | `ttl-alpha.txt` via UI             | fast-path → `ready`, answers `ALPHA-4417`     | ✓      |
| Idle chat                | chat + message backdated 20d       | expired; bytes + sidecar gone; row tombstoned | ✓      |
| Kept by message          | chat backdated 20d, message recent | kept                                          | ✓      |
| Kept by `last_viewed_at` | chat created 20d, viewed now       | kept                                          | ✓      |
| Deleted-chat fallback    | file 20d, chat row absent          | expired (COALESCE → `created_at`)             | ✓      |
| No over-deletion         | other users' recent-chat files     | untouched (expired total = 2)                 | ✓      |
| Graceful answer          | ask after expiry                   | "expired after 14 days … please re-upload"    | ✓      |
| Idempotent               | re-run sweep                       | `{expired:0}`                                 | ✓      |
| Route auth               | wrong token                        | 401                                           | ✓      |

Sweep summaries: `#1 {expired:1}` (delta), `#2 {expired:1, 23022 bytes}`
(alpha), `#3 {expired:0}`. Test data cleaned up afterward.

## Deploy (pending approval)

Not yet on prod. Deploying will:

1. Merge `admin-feature` → `dev`, rebuild the prod stack (no DB migration).
   This **removes the legacy 3-day age-based cleanup** and replaces it with
   the opt-in chat-idle sweep.
2. Set `UPLOAD_TTL_DAYS=14` in prod's `.env` (via the model-manager) to enable
   the new sweep. If left unset, **nothing expires** (both the legacy path and
   the new default-on behavior are gone).
3. Install a daily cron on the app host:
   `curl -fsS -X POST http://localhost:3738/api/maintenance/expire-uploads -H "Authorization: Bearer $INGEST_API_TOKEN"`.
4. The model-manager container must be rebuilt separately for the registry
   entry to appear in its UI.

Net behavior change: today prod deletes uploads older than 3 days by upload
age (no tombstone); after deploy it deletes them 14 days after their chat goes
idle, with a graceful "re-upload" message.
