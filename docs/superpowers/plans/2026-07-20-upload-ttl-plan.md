# Upload TTL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically delete uploaded files once their chat has been idle for a configurable period (default 14 days), freeing the uploads volume, while degrading gracefully (a tombstone row + a "re-upload" note) so expiry never breaks history or hallucinates content.

**Architecture:** A single system-level sweep, `expireIdleUploads()`, added to `lib/db/file-actions.ts`. It selects files whose chat's last activity is older than the TTL (chat id parsed from `object_key`, activity = `GREATEST(last_viewed_at, chat.created_at, last message)`, `created_at` fallback for orphaned/`none` files), unlinks the bytes + `.chunks.json` sidecar, and tombstones the row `status='expired'`. It is triggered by a token-authed `POST /api/maintenance/expire-uploads` route run by a daily cron on `.231`. The answer path and the UI recognize `status='expired'` and tell the user to re-upload.

**Tech Stack:** Next.js 16 / React 19, Drizzle + postgres-js, Vitest (`bun run test`), the existing uploads ingestion feature (job-state actions, `checkIngestAuth`, on-disk `.chunks.json` sidecars).

## Global Constraints

- Branch `admin-feature`. **No prod push without explicit user approval.** Staging (`:3739`) first.
- **No "Co-Authored-By: Claude" / AI-attribution trailer** on any commit.
- Test runner is **`bun run test`** (never `bun test`). Also gate each task on `bun typecheck`, `bunx eslint <touched>`, `bunx prettier --write <touched>`.
- **`status` is a drizzle TS-enum over a plain `varchar`** (`enum: ['pending','processing','ready','failed']` in `lib/db/schema.ts`). Adding `'expired'` to that array is a **TypeScript-only** change — drizzle-kit generates **no migration** (the DB column is unchanged `varchar`). Verify no migration is produced.
- **Chat-idle clock (exact):** a file is expirable when
  `COALESCE(GREATEST(c.last_viewed_at, c.created_at, m.last_msg), f.created_at) < now() - (UPLOAD_TTL_DAYS days)`,
  where `c` is `chats` joined by `c.id = split_part(f.object_key, '/', 3)` and `m.last_msg = max(messages.created_at)` for that chat. Postgres `GREATEST` ignores NULLs (NULL only if all NULL), and `c.created_at` is never NULL when the chat exists.
- **`UPLOAD_TTL_DAYS`**: integer, default `14`; `0`/unset/non-positive ⇒ sweep is a no-op (feature disabled).
- **Object-key layout:** `<userId>/chats/<chatId>/<ts>-<name>`; `split_part(object_key,'/',3)` is the chat id (segments never contain `/`). On-disk paths: bytes = `path.join(UPLOADS_DIR, object_key)`, sidecar = `chunksFilePath(bytes)` = `bytes + '.chunks.json'`. `UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'`.
- **Auth:** reuse `INGEST_API_TOKEN` + `checkIngestAuth` (`lib/utils/ingest-auth.ts`) — do not add a new token or duplicate the check.
- The sweep runs as the **service** (raw `db` client, bypasses RLS) exactly like the other actions in `file-actions.ts` — it is a cross-user maintenance job.
- **Chat-idle SQL semantics are validated by the staging E2E (Task 7)**, not unit tests — the `WHERE` runs in Postgres and is not exercised by the mocked-`db` unit tests. Unit tests cover the Node-side (unlink/tombstone/summary/path-guard/disabled).

---

### Task 1: Schema/type widening + `expireIdleUploads()` core action

**Files:**

- Modify: `lib/db/schema.ts` (status enum), `lib/types/index.ts` (`UploadedFile.ingestStatus`)
- Modify: `lib/db/file-actions.ts` (add the action)
- Test: `lib/db/__tests__/file-actions.test.ts` (extend)

**Interfaces:**

- Produces: `export async function expireIdleUploads(): Promise<ExpireSummary>` and `export interface ExpireSummary { expired: number; bytesFreed: number; scanned: number }` — consumed by Task 3 (route) and Task 7.
- Produces: `status` union widened to include `'expired'` — consumed by Tasks 4, 5.

- [ ] **Step 1: Widen the status type (TS-only, no migration).** In `lib/db/schema.ts`, change the `libraryFiles.status` enum array to `['pending', 'processing', 'ready', 'failed', 'expired']`. In `lib/types/index.ts`, change `ingestStatus?: 'pending' | 'processing' | 'ready' | 'failed'` to also include `'expired'`.

- [ ] **Step 2: Confirm no migration is generated.** Run `bunx drizzle-kit generate` (or the repo's generate script) and confirm it reports no schema changes / creates no new `drizzle/00NN_*.sql`. If it _does_ generate one (unexpected), discard it — the varchar column is unchanged. Then `bun typecheck` (the wider union must not break existing `status ===` comparisons).

- [ ] **Step 3: Write the failing unit tests.** Extend `lib/db/__tests__/file-actions.test.ts`. Mock `fs` and `upload-rag`'s `chunksFilePath` alongside the existing `@/lib/db` mock:

```ts
// add near the top, beside the existing vi.mock('@/lib/db', ...)
const { stat, unlink } = vi.hoisted(() => ({ stat: vi.fn(), unlink: vi.fn() }))
vi.mock('node:fs', () => ({ promises: { stat, unlink } }))
vi.mock('@/lib/embeddings/upload-rag', () => ({
  chunksFilePath: (p: string) => p + '.chunks.json'
}))

// ...import expireIdleUploads with the others...

describe('expireIdleUploads', () => {
  const OLD = process.env.UPLOAD_TTL_DAYS
  const OLD_DIR = process.env.UPLOADS_DIR
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.UPLOADS_DIR = '/app/uploads'
    process.env.UPLOAD_TTL_DAYS = '14'
  })
  afterEach(() => {
    process.env.UPLOAD_TTL_DAYS = OLD
    process.env.UPLOADS_DIR = OLD_DIR
  })

  it('is a no-op when UPLOAD_TTL_DAYS is 0/unset', async () => {
    process.env.UPLOAD_TTL_DAYS = '0'
    expect(await expireIdleUploads()).toEqual({
      expired: 0,
      bytesFreed: 0,
      scanned: 0
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('unlinks bytes + sidecar and tombstones each returned row', async () => {
    execute.mockResolvedValueOnce([
      { id: 'f1', object_key: 'u1/chats/c1/1-a.png', size: 100 }
    ]) // the SELECT
    execute.mockResolvedValueOnce([]) // the UPDATE tombstone
    stat.mockResolvedValueOnce({ size: 100 }) // bytes
    stat.mockResolvedValueOnce({ size: 20 }) // sidecar
    unlink.mockResolvedValue(undefined)

    const summary = await expireIdleUploads()

    expect(unlink).toHaveBeenCalledWith('/app/uploads/u1/chats/c1/1-a.png')
    expect(unlink).toHaveBeenCalledWith(
      '/app/uploads/u1/chats/c1/1-a.png.chunks.json'
    )
    // UPDATE ... status='expired' for the row
    const updateSql = execute.mock.calls[1][0]
    expect(String(updateSql)).toMatch(/status/i)
    expect(summary).toEqual({ expired: 1, bytesFreed: 120, scanned: 1 })
  })

  it('skips object keys that would escape the uploads root', async () => {
    execute.mockResolvedValueOnce([
      { id: 'evil', object_key: '../../etc/passwd', size: 0 }
    ])
    await expireIdleUploads()
    expect(unlink).not.toHaveBeenCalled()
    // no tombstone UPDATE for a skipped row
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('ignores a missing file (already gone) but still tombstones', async () => {
    execute.mockResolvedValueOnce([
      { id: 'f2', object_key: 'u1/chats/c1/2-b.pdf', size: 0 }
    ])
    execute.mockResolvedValueOnce([]) // UPDATE
    stat.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }))
    const summary = await expireIdleUploads()
    expect(summary).toEqual({ expired: 1, bytesFreed: 0, scanned: 1 })
  })
})
```

- [ ] **Step 4: Run tests to confirm they fail.** `bun run test lib/db/__tests__/file-actions.test.ts` — Expected: FAIL (`expireIdleUploads` not exported).

- [ ] **Step 5: Implement `expireIdleUploads()`** in `lib/db/file-actions.ts`. Add imports at the top (`import { promises as fs } from 'node:fs'`, `import path from 'node:path'`, `import { chunksFilePath } from '@/lib/embeddings/upload-rag'`) and the module const `const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'`.

```ts
export interface ExpireSummary {
  expired: number
  bytesFreed: number
  scanned: number
}

function uploadTtlDays(): number {
  const n = Number(process.env.UPLOAD_TTL_DAYS ?? 14)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

async function unlinkQuietly(p: string): Promise<number> {
  try {
    const st = await fs.stat(p)
    await fs.unlink(p)
    return st.size
  } catch {
    return 0 // already gone
  }
}

// Delete uploads whose chat has been idle past UPLOAD_TTL_DAYS. Idle activity is
// GREATEST(chat.last_viewed_at, chat.created_at, last message); a file whose chat
// is gone/'none' falls back to the file's own created_at. Bytes + the
// .chunks.json sidecar are unlinked and the row is tombstoned status='expired'
// (kept so the answer path + UI can say "expired — re-upload"). Skips in-flight
// ingests. UPLOAD_TTL_DAYS=0/unset disables the sweep.
export async function expireIdleUploads(): Promise<ExpireSummary> {
  const days = uploadTtlDays()
  if (days === 0) return { expired: 0, bytesFreed: 0, scanned: 0 }

  const result = await db.execute(sql`
    SELECT f.id, f.object_key, f.size
    FROM files f
    LEFT JOIN chats c ON c.id = split_part(f.object_key, '/', 3)
    LEFT JOIN (
      SELECT chat_id, max(created_at) AS last_msg FROM messages GROUP BY chat_id
    ) m ON m.chat_id = c.id
    WHERE f.status <> 'expired'
      AND f.object_key IS NOT NULL
      AND NOT (f.status = 'processing'
               AND f.claimed_at > now() - interval '${sql.raw(String(STALE_CLAIM_MINUTES))} minutes')
      AND COALESCE(GREATEST(c.last_viewed_at, c.created_at, m.last_msg), f.created_at)
          < now() - (${days}::int * interval '1 day')
  `)
  const rows = execRows(result)

  let expired = 0
  let bytesFreed = 0
  for (const row of rows) {
    const abs = path.join(UPLOADS_DIR, row.object_key)
    // Never unlink outside the uploads root (defense-in-depth; object_key is
    // ours, but a malformed key must not delete arbitrary files).
    if (abs !== UPLOADS_DIR && !abs.startsWith(UPLOADS_DIR + path.sep)) continue
    bytesFreed += await unlinkQuietly(abs)
    bytesFreed += await unlinkQuietly(chunksFilePath(abs))
    await db.execute(sql`
      UPDATE files SET status = 'expired', ingest_stage = NULL, updated_at = now()
      WHERE id = ${row.id}
    `)
    expired++
  }
  return { expired, bytesFreed, scanned: rows.length }
}
```

- [ ] **Step 6: Run tests to confirm they pass.** `bun run test lib/db/__tests__/file-actions.test.ts` — Expected: PASS. Then `bun typecheck`, `bunx eslint lib/db/file-actions.ts lib/db/schema.ts lib/types/index.ts`, `bunx prettier --write` the touched files.

- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(uploads): expireIdleUploads sweep — delete chat-idle files + sidecar, tombstone row"`

---

### Task 2: Orphan garbage-collection (optional, droppable)

Reclaims two edge classes the main sweep misses. Keep it strict and capped; it may be deferred if the reviewer deems it risky — the core disk win is Task 1.

**Files:**

- Modify: `lib/db/file-actions.ts` (add `gcOrphanUploads()`, call it from `expireIdleUploads()` after the main loop)
- Test: `lib/db/__tests__/file-actions.test.ts` (extend)

**Interfaces:**

- Consumes: `ExpireSummary` from Task 1. Extend it with `orphansRemoved: number` and update Task 1's tests/return accordingly (add `orphansRemoved: 0` to the disabled-path and existing expectations).

- [ ] **Step 1: Write failing tests.** Cover: (a) a `files` row whose bytes are missing and whose chat is idle → tombstoned `expired` (DB-side, via the same SELECT already returning it — assert it's counted, bytesFreed 0); (b) a stray on-disk file whose `object_key` matches **no** row and is older than the TTL → unlinked; (c) a stray file that DOES match a live row → left untouched. Mock `fs.readdir`/`fs.stat`/`fs.unlink` and the DB `select`/`execute`.

- [ ] **Step 2: Run to confirm fail.** `bun run test lib/db/__tests__/file-actions.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `gcOrphanUploads()`.** Walk `UPLOADS_DIR` (recursive `fs.readdir(..., { withFileTypes: true })`), skip `.chunks.json` sidecars, derive each file's `object_key` relative to `UPLOADS_DIR`, and for any file with mtime older than the TTL whose `object_key` is absent from `files`, unlink it + its sidecar. Cap the number of deletions per run (e.g. 500) and `log()` if the cap is hit (no silent truncation). Call it at the end of `expireIdleUploads()` and fold its count into `orphansRemoved`.

- [ ] **Step 4: Run to confirm pass**, then typecheck/eslint/prettier.

- [ ] **Step 5: Commit.** `git commit -m "feat(uploads): GC orphaned upload files/sidecars during the idle sweep"`

---

### Task 3: Token-authed sweep route

**Files:**

- Create: `app/api/maintenance/expire-uploads/route.ts`
- Test: `app/api/maintenance/expire-uploads/__tests__/route.test.ts`

**Interfaces:**

- Consumes: `expireIdleUploads()` from Task 1; `checkIngestAuth` from `lib/utils/ingest-auth.ts`.

- [ ] **Step 1: Write failing tests** mirroring `app/api/upload/__tests__/route.test.ts` structure. Mock `@/lib/db/file-actions` (`expireIdleUploads` → a fixed summary). Cases: no `INGEST_API_TOKEN` env → 503 (and `expireIdleUploads` not called); wrong bearer → 401; correct bearer → 200 with `{ summary }`. Set/unset `process.env.INGEST_API_TOKEN` per case.

- [ ] **Step 2: Run to confirm fail.** `bun run test app/api/maintenance/expire-uploads/__tests__/route.test.ts` — Expected: FAIL (route missing).

- [ ] **Step 3: Implement the route** (mirrors `app/api/ingest/claim/route.ts`):

```ts
import { NextRequest, NextResponse } from 'next/server'

import { expireIdleUploads } from '@/lib/db/file-actions'
import { checkIngestAuth } from '@/lib/utils/ingest-auth'

export async function POST(req: NextRequest) {
  const auth = checkIngestAuth(req.headers.get('authorization'))
  if (!auth.ok) return new NextResponse(null, { status: auth.status })
  const summary = await expireIdleUploads()
  console.log('[expire-uploads]', JSON.stringify(summary))
  return NextResponse.json({ summary })
}
```

- [ ] **Step 4: Run to confirm pass**, then typecheck/eslint/prettier.

- [ ] **Step 5: Commit.** `git commit -m "feat(uploads): token-authed POST /api/maintenance/expire-uploads"`

---

### Task 4: Answer-time `expired` note in transform-file-parts

**Files:**

- Modify: `lib/streaming/helpers/transform-file-parts.ts`
- Test: `lib/streaming/helpers/__tests__/transform-file-parts.test.ts`

**Interfaces:**

- Consumes: the widened `status` union (Task 1). An `expired` file has **no bytes and no chunks**, so the note must be returned for **all** models (vision included) — placed before the vision/pending/failed gates.

- [ ] **Step 1: Write failing tests** in the existing transform test file. `findFileByObjectKey` mocked to `{ status: 'expired' }`: (a) a normal file part → returns exactly the expired/re-upload note and **never** calls `queryFileChunks`/reads bytes; (b) an image part with `modelHasVision: true` → still returns the note (no base64 attach), since the bytes are gone.

- [ ] **Step 2: Run to confirm fail.** `bun run test lib/streaming/helpers/__tests__/transform-file-parts.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement the branch.** In `transformPart`, immediately after `const status = row?.status ?? 'ready'`, add (before the `const isImage`/`visionImage` logic):

```ts
if (status === 'expired') {
  const days = Number(process.env.UPLOAD_TTL_DAYS ?? 14)
  return [
    {
      type: 'text',
      text: `[Attached file: ${filename} — this upload expired after ${days} days of chat inactivity and is no longer available. Tell the user to re-upload it to ask about it again.]`
    }
  ]
}
```

- [ ] **Step 4: Run to confirm pass** (and the existing transform tests still pass), then typecheck/eslint/prettier.

- [ ] **Step 5: Commit.** `git commit -m "feat(uploads): answer-time 'expired — re-upload' note for expired files"`

---

### Task 5: UI expired state (chip + historical preview)

**Files:**

- Modify: `components/uploaded-file-list.tsx` (compose-time chip)
- Modify: the message file-part/attachment renderer that shows a past message's image/file (locate via `grep -rln "no-img-element\|file.*part\|attachment" components/ | head`; likely `components/render-message.tsx` or an attachment sub-component)
- Test: none required for pure presentational states beyond `bun typecheck`; add a small render test only if the renderer already has one.

**Interfaces:**

- Consumes: `ingestStatus === 'expired'` (Task 1 widened the union) and, for history, an image URL that now 404s.

- [ ] **Step 1: Compose chip.** In `uploaded-file-list.tsx`, add an `expired` affordance next to the `failed` branch — e.g. an overlay with a distinct icon and `title="Expired — re-upload to use again"`, shown when `it.ingestStatus === 'expired'`.

- [ ] **Step 2: Historical preview.** In the message attachment renderer, when an image/file preview fails to load (`onError`) or the file’s known status is `expired`, render an "Expired — re-upload to use again" placeholder instead of a broken image. (If this proves entangled, ship Step 1 now and file Step 2 as a fast-follow — the model-facing note in Task 4 already prevents wrong answers.)

- [ ] **Step 3:** `bun typecheck`, `bunx eslint`/`prettier` on touched files; a quick manual render check is deferred to the Task 7 E2E.

- [ ] **Step 4: Commit.** `git commit -m "feat(uploads): expired attachment state in chip + message preview"`

---

### Task 6: Configuration + cron

**Files:**

- Modify: `selfhosted/model-manager/lib/env-schema.ts` (add `UPLOAD_TTL_DAYS`)
- Modify: prod env (`.env` on `.231`, via the model-manager) — operational, not committed
- Doc: add the cron line to the deploy notes / this plan’s Task 7

**Interfaces:** none (config only).

- [ ] **Step 1: Registry entry.** In `selfhosted/model-manager/lib/env-schema.ts`, add `UPLOAD_TTL_DAYS` following the shape of a numeric/optional entry near `INGEST_API_TOKEN` (label "Upload TTL (days)", default `14`, help: "Delete uploaded files this many days after their chat goes idle; 0 disables."). Run the model-manager's own `bun typecheck`/tests (it has its own suite). **Note:** the model-manager container deploys manually/separately from ask.

- [ ] **Step 2:** Confirm the ask runtime reads it: prod `ask` uses `env_file: .env`, so `UPLOAD_TTL_DAYS=14` in prod `.env` reaches `process.env`. No compose change needed.

- [ ] **Step 3: Cron (documented; applied at deploy in Task 7).** Daily on `.231`:

  ```
  15 4 * * *  curl -fsS -X POST http://localhost:3738/api/maintenance/expire-uploads -H "Authorization: Bearer $INGEST_API_TOKEN" >/dev/null 2>&1
  ```

- [ ] **Step 4: Commit** the registry change: `git commit -m "feat(uploads): UPLOAD_TTL_DAYS in model-manager env registry"` (in the ask repo; the model-manager lives under `selfhosted/` but is committed with ask per repo layout).

---

### Task 7: Deploy to staging + E2E (validates the chat-idle SQL)

This is the integration gate. The chat-idle `WHERE` runs in real Postgres, so this is where its correctness is proven.

- [ ] **Step 1:** Rebuild staging on `admin-feature` (`docker compose -f docker-compose.admin-feature.yaml … up -d --build`), with `UPLOAD_TTL_DAYS=14` in staging’s env. Confirm no migration ran (schema unchanged).

- [ ] **Step 2:** Via the staging UI, create **two** chats each with an uploaded image (both ingested `ready`, bytes + sidecar on disk).

- [ ] **Step 3:** In staging Postgres, backdate **chat A**'s activity past the TTL — set `chats.last_viewed_at` and `chats.created_at` and its messages' `created_at` to `now() - interval '20 days'`. Leave **chat B** fresh.

- [ ] **Step 4:** POST the sweep route with the token. Assert the returned summary shows `expired >= 1`. Verify on disk: **A**'s bytes + `.chunks.json` are gone, **B**'s remain. Verify DB: A's row `status='expired'`, B's unchanged.

- [ ] **Step 5:** In chat A, ask a follow-up about the (now-expired) image; confirm the answer reports it expired and asks to re-upload (the Task 4 note). Confirm chat B still answers from its file. Confirm the expired chip/preview (Task 5).

- [ ] **Step 6:** Re-run the sweep; assert it's idempotent (A not re-processed; summary `expired` for A = 0).

- [ ] **Step 7:** Report results. **Do not deploy to prod until the user approves.** On approval: follow the push-to-production workflow (merge `admin-feature`→`dev`, push, rebuild prod, checkout back), set `UPLOAD_TTL_DAYS=14` in prod `.env` via the model-manager, install the `.231` cron, and smoke-test the route on prod.

---

## Notes for the executor

- Task 2 (orphan GC) and Task 5 Step 2 (historical preview) are the two trim points if scope needs cutting — the core value (chat-idle expiry + graceful model note + config + cron) is Tasks 1, 3, 4, 6, 7.
- Do **not** add a DB migration unless drizzle-kit unexpectedly generates one for the varchar (it should not).
- Keep the reviewer’s attention on: the chat-idle SQL (`split_part` index 3, `GREATEST` NULL semantics, `COALESCE` fallback), the path-escape guard, TTL-disabled short-circuit, and that `expired` is handled before the vision/base64 branch.
