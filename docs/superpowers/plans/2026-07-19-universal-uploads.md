# Universal Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Ask's uploads to all common document/media types, ingested asynchronously by a pull-based worker on NightFuryX, with per-file status and status-aware answers.

**Architecture:** Ask owns job state (Postgres `files` table) and embedding; a new standalone Python worker (`selfhosted/ingestor`) claims jobs over token-authed HTTP, extracts text on CPU (pandoc/libreoffice/poppler/faster-whisper/ffmpeg) with VLM calls to the box's ollama (`qwen3-vl:4b` on the GTX 1070), and reports chunks back. A local fast path in Ask keeps text documents working when the worker is offline.

**Tech Stack:** Next.js 16 / TypeScript / Drizzle / vitest (Ask); Python 3.12 + Docker (worker); ollama VLM; faster-whisper CPU int8.

**Spec:** `docs/superpowers/specs/2026-07-19-universal-uploads-design.md` — binding for every task.

## Global Constraints

- `INGEST_API_TOKEN` unset ⇒ all `/api/ingest/*` routes return **503** (fail closed). Auth = `Authorization: Bearer <token>`, compared with `crypto.timingSafeEqual` semantics (use `hmac`-style constant-time compare as in the reranker service).
- Upload cap **2GB** (`MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024`); request body **streamed to disk**, never buffered whole.
- Fast path: `application/pdf` + text-family files **≤ 20MB** only; "meaningful text" = trimmed length **> 200** chars.
- Claim staleness **30 minutes**; max **3** attempts; then `failed` with `ingestError='retries exhausted'`.
- Caps: **40** video keyframes, **200** OCR pages, **2000** chunks per file (server-side in `/complete`).
- VLM calls serialized (**1** at a time, global lock); worker job concurrency **2**; poll interval **15s** when idle.
- Timestamp chunk prefix format: `[HH:MM:SS–HH:MM:SS] ` (en dash).
- Audio/video transcript chunks ≈ **2-minute** windows.
- Whisper: faster-whisper, `large-v3`, `device="cpu"`, `compute_type="int8"`.
- Status enum exactly: `pending | processing | ready | failed`. Existing rows backfilled to `ready` in the migration.
- Ask tests: `bun run test` (vitest). Pre-commit for every Ask task: `bun lint`, `bun typecheck`, touched-file `bunx prettier --write`.
- No prod push in this plan — build + staging only; production rollout is a separate user-approved step.
- Worker env names exactly: `ASK_URL`, `INGEST_API_TOKEN`, `OLLAMA_URL`, `VLM_MODEL`, `WHISPER_MODEL`, `MAX_VIDEO_FRAMES`, `JOB_CONCURRENCY`.

## File structure (both deliverables)

```
ask/
  lib/db/file-actions.ts                  (NEW — files-table job-state actions)
  lib/db/schema.ts                        (MODIFY — files ingestion columns)
  drizzle/0018_files_ingest_status.sql    (NEW — migration)
  lib/utils/ingest-auth.ts                (NEW — bearer check for /api/ingest/*)
  app/api/upload/route.ts                 (MODIFY — streaming, allowlist, row, fast path)
  app/api/ingest/claim/route.ts           (NEW)
  app/api/ingest/file/[id]/route.ts       (NEW)
  app/api/ingest/progress/route.ts        (NEW)
  app/api/ingest/complete/route.ts        (NEW)
  app/api/files/status/route.ts           (NEW — session-authed chip polling)
  lib/embeddings/upload-rag.ts            (MODIFY — text-family fast-path extraction)
  lib/streaming/helpers/transform-file-parts.ts (MODIFY — generalize + status-aware)
  lib/types/index.ts                      (MODIFY — UploadedFile gains id/ingest fields)
  components/chat-panel.tsx               (MODIFY — capture file id from upload response)
  components/uploaded-file-list.tsx       (MODIFY — status chip + polling)
  selfhosted/model-manager/lib/env-schema.ts (MODIFY — INGEST_API_TOKEN entry)
selfhosted/ingestor/                      (NEW service — lives OUTSIDE the ask repo tree,
  Dockerfile                               at /home/nightfury/selfhosted/ingestor on .231,
  docker-compose.yaml                      deployed to the same path on .169; NOT committed
  .env.example                             to the ask repo, same as reranker-qwen/embedder)
  requirements.txt
  app/config.py
  app/ask_client.py
  app/chunking.py
  app/vlm.py
  app/extractors/documents.py
  app/extractors/image_ocr.py
  app/extractors/audio.py
  app/extractors/video.py
  app/worker.py
  tests/test_chunking.py
  tests/test_dispatch.py
  smoke_test.py
```

---

### Task 1: `files` ingestion columns, migration, and `file-actions`

**Files:**
- Modify: `lib/db/schema.ts` (files table, after `size`)
- Create: `drizzle/0018_files_ingest_status.sql`
- Create: `lib/db/file-actions.ts`
- Test: `lib/db/__tests__/file-actions.test.ts`

**Interfaces:**
- Produces (used by Tasks 2–6):
  - `createFileRecord(input: { userId: string; chatId: string | null; filename: string; url: string; objectKey: string; mediaType: string; size: number; status?: 'pending' | 'ready' }): Promise<{ id: string }>`
  - `findFileByObjectKey(objectKey: string): Promise<FileRow | null>`
  - `markFileReady(id: string): Promise<void>` (sets `status='ready'`, `ingestedAt=now()`, clears `ingestError`)
  - `claimNextIngestJob(): Promise<{ id: string; filename: string; mediaType: string; size: number | null; objectKey: string } | null>`
  - `updateIngestProgress(id: string, stage: string): Promise<boolean>` (also refreshes `claimedAt`; false if row missing/not processing)
  - `completeIngestFailure(id: string, error: string, retryable: boolean): Promise<'pending' | 'failed'>`
  - `getFileStatusesForUser(userId: string, objectKeys: string[]): Promise<Array<{ objectKey: string; status: string; ingestStage: string | null; ingestError: string | null }>>`
  - `FileRow` = `InferSelectModel<typeof files>`

- [ ] **Step 1: Add columns to `lib/db/schema.ts`** — inside the `files` table definition, after `size: integer('size'),`:

```ts
    // Ingestion job state (universal uploads). pending → processing →
    // ready | failed. Rows that predate the feature are backfilled to
    // 'ready' by the migration.
    status: varchar('status', {
      length: VARCHAR_LENGTH,
      enum: ['pending', 'processing', 'ready', 'failed']
    })
      .notNull()
      .default('pending'),
    ingestStage: varchar('ingest_stage', { length: VARCHAR_LENGTH }),
    attempts: integer('attempts').notNull().default(0),
    claimedAt: timestamp('claimed_at'),
    ingestError: text('ingest_error'),
    ingestedAt: timestamp('ingested_at'),
```

- [ ] **Step 2: Write `drizzle/0018_files_ingest_status.sql`**

```sql
ALTER TABLE "files" ADD COLUMN "status" varchar(256) NOT NULL DEFAULT 'pending';
ALTER TABLE "files" ADD COLUMN "ingest_stage" varchar(256);
ALTER TABLE "files" ADD COLUMN "attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "files" ADD COLUMN "claimed_at" timestamp;
ALTER TABLE "files" ADD COLUMN "ingest_error" text;
ALTER TABLE "files" ADD COLUMN "ingested_at" timestamp;
-- Rows that predate ingestion tracking already work (or never will): ready.
UPDATE "files" SET "status" = 'ready';
CREATE INDEX "files_status_created_at_idx" ON "files" ("status","created_at");
```

Register it in `drizzle/meta/_journal.json` following the exact entry shape of `0017_conversation_chunks.sql` (copy the previous entry, bump `idx` to 18, tag `0018_files_ingest_status`, use `Date.now()` of authoring as `when`).

- [ ] **Step 3: Write the failing tests** — `lib/db/__tests__/file-actions.test.ts`. Follow the mocking style of `lib/db/__tests__/rls-policies.integration.test.ts` (mock `@/lib/db` with a chainable stub). Cover: `completeIngestFailure` returns `'pending'` when `retryable && attempts < 3` and `'failed'` otherwise (both branches assert the UPDATE payload), `claimNextIngestJob` returns null when the claim query yields no rows, `getFileStatusesForUser` filters by `userId` AND `inArray(objectKey)`.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const execute = vi.fn()
vi.mock('@/lib/db', () => ({ db: { execute } }))

import {
  claimNextIngestJob,
  completeIngestFailure
} from '../file-actions'

describe('file-actions ingest state', () => {
  beforeEach(() => vi.clearAllMocks())

  it('claimNextIngestJob returns null on an empty queue', async () => {
    execute.mockResolvedValueOnce({ rows: [] })
    expect(await claimNextIngestJob()).toBeNull()
  })

  it('claimNextIngestJob returns the claimed row', async () => {
    execute.mockResolvedValueOnce({
      rows: [
        {
          id: 'f1',
          filename: 'a.mp3',
          media_type: 'audio/mpeg',
          size: 123,
          object_key: 'u1/chats/c1/1-a.mp3'
        }
      ]
    })
    expect(await claimNextIngestJob()).toEqual({
      id: 'f1',
      filename: 'a.mp3',
      mediaType: 'audio/mpeg',
      size: 123,
      objectKey: 'u1/chats/c1/1-a.mp3'
    })
  })

  it('completeIngestFailure requeues retryable failures with attempts left', async () => {
    execute.mockResolvedValueOnce({ rows: [{ attempts: 1 }] }) // current row
    execute.mockResolvedValueOnce({ rows: [] }) // update
    expect(await completeIngestFailure('f1', 'ollama down', true)).toBe(
      'pending'
    )
  })

  it('completeIngestFailure fails permanently when attempts are exhausted', async () => {
    execute.mockResolvedValueOnce({ rows: [{ attempts: 3 }] })
    execute.mockResolvedValueOnce({ rows: [] })
    expect(await completeIngestFailure('f1', 'ollama down', true)).toBe(
      'failed'
    )
  })

  it('completeIngestFailure fails immediately on non-retryable errors', async () => {
    execute.mockResolvedValueOnce({ rows: [{ attempts: 0 }] })
    execute.mockResolvedValueOnce({ rows: [] })
    expect(await completeIngestFailure('f1', 'corrupt file', false)).toBe(
      'failed'
    )
  })
})
```

- [ ] **Step 4: Run to verify failure** — `bunx vitest run lib/db/__tests__/file-actions.test.ts` → FAIL (module not found).

- [ ] **Step 5: Implement `lib/db/file-actions.ts`**

```ts
// Job-state actions for the universal-uploads ingestion queue. These run
// as the SERVICE (no user session): the worker API routes call them with
// the raw db client, which as table owner bypasses RLS — the routes are
// gated by INGEST_API_TOKEN instead. getFileStatusesForUser is the one
// user-facing reader and filters by userId explicitly.
import { and, eq, inArray, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { files } from '@/lib/db/schema'
import type { InferSelectModel } from 'drizzle-orm'

export type FileRow = InferSelectModel<typeof files>

const MAX_ATTEMPTS = 3
const STALE_CLAIM_MINUTES = 30

export async function createFileRecord(input: {
  userId: string
  chatId: string | null
  filename: string
  url: string
  objectKey: string
  mediaType: string
  size: number
  status?: 'pending' | 'ready'
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(files)
    .values({
      userId: input.userId,
      chatId: input.chatId,
      filename: input.filename,
      url: input.url,
      objectKey: input.objectKey,
      mediaType: input.mediaType,
      size: input.size,
      status: input.status ?? 'pending'
    })
    .returning({ id: files.id })
  return row
}

export async function findFileByObjectKey(
  objectKey: string
): Promise<FileRow | null> {
  const rows = await db
    .select()
    .from(files)
    .where(eq(files.objectKey, objectKey))
    .limit(1)
  return rows[0] ?? null
}

export async function markFileReady(id: string): Promise<void> {
  await db
    .update(files)
    .set({ status: 'ready', ingestedAt: new Date(), ingestError: null })
    .where(eq(files.id, id))
}

// Atomic claim: oldest pending job, or a stale processing job (worker
// crashed / box slept mid-run). FOR UPDATE SKIP LOCKED makes concurrent
// claims safe. Jobs at the attempt cap are finalized to failed by the
// same statement family (see completeIngestFailure); the claim query
// simply never selects rows with attempts >= MAX_ATTEMPTS.
export async function claimNextIngestJob(): Promise<{
  id: string
  filename: string
  mediaType: string
  size: number | null
  objectKey: string
} | null> {
  const result = await db.execute(sql`
    UPDATE files SET
      status = 'processing',
      claimed_at = now(),
      attempts = attempts + 1,
      ingest_stage = 'claimed'
    WHERE id = (
      SELECT id FROM files
      WHERE attempts < ${MAX_ATTEMPTS} AND (
        status = 'pending' OR (
          status = 'processing' AND
          claimed_at < now() - interval '${sql.raw(String(STALE_CLAIM_MINUTES))} minutes'
        )
      )
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, filename, media_type, size, object_key
  `)
  const row = (result as any).rows?.[0]
  if (!row) return null
  return {
    id: row.id,
    filename: row.filename,
    mediaType: row.media_type,
    size: row.size,
    objectKey: row.object_key
  }
}

export async function updateIngestProgress(
  id: string,
  stage: string
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE files SET ingest_stage = ${stage}, claimed_at = now()
    WHERE id = ${id} AND status = 'processing'
    RETURNING id
  `)
  return Boolean((result as any).rows?.[0])
}

export async function completeIngestFailure(
  id: string,
  error: string,
  retryable: boolean
): Promise<'pending' | 'failed'> {
  const current = await db.execute(
    sql`SELECT attempts FROM files WHERE id = ${id}`
  )
  const attempts = Number((current as any).rows?.[0]?.attempts ?? MAX_ATTEMPTS)
  const next: 'pending' | 'failed' =
    retryable && attempts < MAX_ATTEMPTS ? 'pending' : 'failed'
  await db.execute(sql`
    UPDATE files SET
      status = ${next},
      ingest_error = ${error},
      ingest_stage = NULL,
      claimed_at = NULL
    WHERE id = ${id}
  `)
  return next
}

export async function getFileStatusesForUser(
  userId: string,
  objectKeys: string[]
): Promise<
  Array<{
    objectKey: string
    status: string
    ingestStage: string | null
    ingestError: string | null
  }>
> {
  if (objectKeys.length === 0) return []
  const rows = await db
    .select({
      objectKey: files.objectKey,
      status: files.status,
      ingestStage: files.ingestStage,
      ingestError: files.ingestError
    })
    .from(files)
    .where(and(eq(files.userId, userId), inArray(files.objectKey, objectKeys)))
  return rows.map(r => ({ ...r, objectKey: r.objectKey ?? '' }))
}
```

- [ ] **Step 6: Run tests to verify pass** — `bunx vitest run lib/db/__tests__/file-actions.test.ts` → PASS. Then `bun typecheck` (the mocked-db tests compile against the real signatures).

- [ ] **Step 7: Apply the migration to staging DB** — `docker exec ask-admin-feature bun migrate` (staging Postgres); verify: `docker exec ask-postgres-admin-feature psql -U morphic -d morphic -c "\d files" | grep -E "status|ingest"`.

- [ ] **Step 8: Commit** — `git add lib/db/schema.ts lib/db/file-actions.ts lib/db/__tests__/file-actions.test.ts drizzle/0018_files_ingest_status.sql drizzle/meta/_journal.json && git commit -m "feat(uploads): files ingestion state columns and job-state actions"`

---

### Task 2: Fast-path extraction in `upload-rag`

**Files:**
- Modify: `lib/embeddings/upload-rag.ts`
- Test: `lib/embeddings/__tests__/upload-rag-fastpath.test.ts`

**Interfaces:**
- Produces: `processFileForRAG(filePath, mediaType, filename): Promise<boolean>` — CHANGED return type: `true` if a chunks file was written (fast path succeeded), `false` otherwise. Text-family support widened.
- Produces: `TEXT_FAMILY_TYPES: Set<string>` and `isTextFamily(mediaType: string, filename: string): boolean` — exported for the upload route's fast-path eligibility check (Task 3).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests** — `lib/embeddings/__tests__/upload-rag-fastpath.test.ts`. Mock `./transformers-embedding`'s `embedTexts` (return fixed vectors) as `lib/embeddings/__tests__/upload-rag-rerank.test.ts` already does; use a temp dir with real small files:

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../transformers-embedding', async importOriginal => {
  const orig = await importOriginal<any>()
  return {
    ...orig,
    embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
    getConfiguredModel: () => 'mixedbread-ai/mxbai-embed-large-v1'
  }
})

import { isTextFamily, processFileForRAG } from '../upload-rag'

describe('fast-path extraction', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rag-'))
  })

  it('indexes markdown and returns true', async () => {
    const p = path.join(dir, 'notes.md')
    await writeFile(p, '# Title\n\n' + 'meaningful content here. '.repeat(20))
    expect(await processFileForRAG(p, 'text/markdown', 'notes.md')).toBe(true)
    const stored = JSON.parse(await readFile(p + '.chunks.json', 'utf-8'))
    expect(stored.chunks.length).toBeGreaterThan(0)
  })

  it('returns false for content under the 200-char floor', async () => {
    const p = path.join(dir, 'tiny.txt')
    await writeFile(p, 'too short')
    expect(await processFileForRAG(p, 'text/plain', 'tiny.txt')).toBe(false)
  })

  it('returns false for media types it cannot extract', async () => {
    const p = path.join(dir, 'song.mp3')
    await writeFile(p, 'not really audio')
    expect(await processFileForRAG(p, 'audio/mpeg', 'song.mp3')).toBe(false)
  })

  it('classifies text-family by media type and extension', () => {
    expect(isTextFamily('text/plain', 'a.txt')).toBe(true)
    expect(isTextFamily('application/octet-stream', 'main.rs')).toBe(true)
    expect(isTextFamily('application/pdf', 'doc.pdf')).toBe(true)
    expect(isTextFamily('video/mp4', 'clip.mp4')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `bunx vitest run lib/embeddings/__tests__/upload-rag-fastpath.test.ts` → FAIL (`isTextFamily` not exported; return type void).

- [ ] **Step 3: Implement in `lib/embeddings/upload-rag.ts`** — replace `processFileForRAG` and add the classifier. Keep `extractPdfText` as is.

```ts
// Extensions treated as plain text for the local fast path (code files
// often arrive as application/octet-stream, so extension matters too).
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'csv', 'html', 'htm', 'json', 'yaml', 'yml', 'toml',
  'ts', 'js', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'sh'
])

export function isTextFamily(mediaType: string, filename: string): boolean {
  if (mediaType === 'application/pdf') return true
  if (mediaType.startsWith('text/')) return true
  if (mediaType === 'application/json') return true
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return TEXT_EXTENSIONS.has(ext)
}

const MIN_MEANINGFUL_CHARS = 200

// Local fast-path ingestion. Returns true iff a chunks file was written —
// the upload route uses that to mark the file `ready` without the worker.
export async function processFileForRAG(
  filePath: string,
  mediaType: string,
  filename: string
): Promise<boolean> {
  let text = ''

  if (mediaType === 'application/pdf') {
    text = await extractPdfText(filePath)
  } else if (isTextFamily(mediaType, filename)) {
    try {
      text = await fs.readFile(filePath, 'utf-8')
    } catch {
      return false
    }
  } else {
    return false // media and office formats belong to the worker
  }

  const trimmed = text.trim()
  if (trimmed.length <= MIN_MEANINGFUL_CHARS) return false

  const model = getConfiguredModel()
  const chunks = splitText(trimmed, 512, 128)
  if (chunks.length === 0) return false

  const embeddings = await embedTexts(chunks, model)

  const stored: ChunksFile = {
    model,
    filename,
    chunks: chunks.map((content, i) => ({ content, embedding: embeddings[i] }))
  }

  await fs.writeFile(chunksFilePath(filePath), JSON.stringify(stored))
  return true
}
```

Also export a helper the complete-route (Task 4) will reuse to write worker-extracted chunks:

```ts
// Embed worker-extracted chunk texts and store them in the standard
// chunks-file format. Oversized entries are re-split defensively so a
// worker bug can't produce chunks beyond what the embedder handles well.
export async function storeExtractedChunks(
  filePath: string,
  filename: string,
  chunkTexts: string[]
): Promise<void> {
  const normalized = chunkTexts.flatMap(t =>
    t.length > 4000 ? splitText(t, 512, 128) : [t]
  )
  const model = getConfiguredModel()
  const embeddings = await embedTexts(normalized, model)
  const stored: ChunksFile = {
    model,
    filename,
    chunks: normalized.map((content, i) => ({
      content,
      embedding: embeddings[i]
    }))
  }
  await fs.writeFile(chunksFilePath(filePath), JSON.stringify(stored))
}
```

- [ ] **Step 4: Run tests** — the new file AND the existing `lib/embeddings/__tests__/upload-rag-rerank.test.ts` + `upload-rag-rerank` suites: `bunx vitest run lib/embeddings/` → PASS.

- [ ] **Step 5: Commit** — `git add lib/embeddings/upload-rag.ts lib/embeddings/__tests__/upload-rag-fastpath.test.ts && git commit -m "feat(uploads): text-family fast-path extraction + storeExtractedChunks"`

---

### Task 3: Upload route — streaming writes, 2GB cap, allowlist, file row, fast path

**Files:**
- Modify: `app/api/upload/route.ts` (full rewrite of POST)
- Modify: `lib/types/index.ts` (`UploadedFile` gains `id?: string`, `objectKey?: string`, `ingestStatus?: 'pending' | 'processing' | 'ready' | 'failed'`)
- Modify: `components/chat-panel.tsx` (upload fetch: send raw streamed body with metadata headers; store returned `file.id`/`objectKey`/`status` into the `UploadedFile`)
- Test: `app/api/upload/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `createFileRecord`, `markFileReady` (Task 1); `processFileForRAG`, `isTextFamily` (Task 2).
- Produces: upload response shape `{ success: true, file: { id, filename, url, mediaType, objectKey, status, type: 'file' } }` — the client and Task 6 chip rely on `id`, `objectKey`, `status`.

Client change in `chat-panel.tsx` (replace the FormData POST inside the existing upload callback):

```ts
const res = await fetch('/api/upload', {
  method: 'POST',
  headers: {
    'content-type': file.type || 'application/octet-stream',
    'x-filename': encodeURIComponent(file.name),
    'x-chat-id': chatId ?? ''
  },
  body: file
})
```

Route implementation (key parts — the whole POST is replaced):

```ts
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024 // 2GB
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'
const FAST_PATH_MAX_BYTES = 20 * 1024 * 1024 // 20MB

const ALLOWED_MEDIA_PREFIXES = ['image/', 'audio/', 'video/', 'text/']
const ALLOWED_EXACT = new Set([
  'application/pdf',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/epub+zip',
  'application/octet-stream' // code files; gated by extension below
])
const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt', 'md', 'html', 'epub',
  'jpg', 'jpeg', 'png', 'webp', 'gif',
  'mp3', 'm4a', 'wav', 'ogg', 'flac',
  'mp4', 'mkv', 'webm', 'mov',
  'ts', 'js', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h',
  'sh', 'json', 'yaml', 'yml', 'toml'
])

function isAllowed(mediaType: string, filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (!ALLOWED_EXTENSIONS.has(ext)) return false
  return (
    ALLOWED_EXACT.has(mediaType) ||
    ALLOWED_MEDIA_PREFIXES.some(p => mediaType.startsWith(p))
  )
}

export async function POST(req: NextRequest) {
  try {
    const userId = await getCurrentUserId()
    if (!userId)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const filename = decodeURIComponent(req.headers.get('x-filename') ?? '')
    const chatId = req.headers.get('x-chat-id') || null
    const mediaType = req.headers.get('content-type') || 'application/octet-stream'
    if (!filename || !req.body)
      return NextResponse.json({ error: 'File is required' }, { status: 400 })
    if (!isAllowed(mediaType, filename))
      return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 })

    const declaredSize = Number(req.headers.get('content-length') ?? 0)
    if (declaredSize > MAX_FILE_SIZE)
      return NextResponse.json({ error: 'File too large (max 2GB)' }, { status: 400 })

    const sanitizedName = sanitizeFilename(filename)
    const objectKey = `${userId}/chats/${chatId ?? 'none'}/${Date.now()}-${sanitizedName}`
    const absPath = path.join(UPLOADS_DIR, objectKey)
    await fs.mkdir(path.dirname(absPath), { recursive: true })

    // Stream the body to disk, enforcing the cap as bytes arrive — a 2GB
    // upload must never be buffered in process memory.
    const { createWriteStream } = await import('node:fs')
    const { Readable } = await import('node:stream')
    const { pipeline } = await import('node:stream/promises')
    let written = 0
    const guard = new (await import('node:stream')).Transform({
      transform(chunk, _enc, cb) {
        written += chunk.length
        if (written > MAX_FILE_SIZE) cb(new Error('too-large'))
        else cb(null, chunk)
      }
    })
    try {
      await pipeline(
        Readable.fromWeb(req.body as any),
        guard,
        createWriteStream(absPath)
      )
    } catch (e) {
      await fs.unlink(absPath).catch(() => {})
      if ((e as Error).message === 'too-large')
        return NextResponse.json({ error: 'File too large (max 2GB)' }, { status: 400 })
      throw e
    }

    const publicUrl = publicUrlFor(req, `/uploads/${objectKey}`)
    const eligibleForFastPath =
      isTextFamily(mediaType, filename) && written <= FAST_PATH_MAX_BYTES

    const { id } = await createFileRecord({
      userId,
      chatId,
      filename,
      url: publicUrl,
      objectKey,
      mediaType,
      size: written,
      status: 'pending'
    })

    if (eligibleForFastPath) {
      // Fire-and-forget like today's chunking; typically done in seconds.
      processFileForRAG(absPath, mediaType, filename)
        .then(ok => (ok ? markFileReady(id) : undefined))
        .catch(err => console.error('[upload] fast path failed:', err))
    }

    return NextResponse.json(
      {
        success: true,
        file: {
          id,
          filename,
          url: publicUrl,
          mediaType,
          objectKey,
          status: 'pending',
          type: 'file'
        }
      },
      { status: 200 }
    )
  } catch (err: any) {
    console.error('Upload Error:', err)
    return NextResponse.json(
      { error: 'Upload failed', message: err.message },
      { status: 500 }
    )
  }
}
```

- [ ] **Step 1: Write failing route tests** — `app/api/upload/__tests__/route.test.ts`, mocking `@/lib/auth/get-current-user` (returns `'u1'`), `@/lib/db/file-actions` and `@/lib/embeddings/upload-rag`; drive `POST` with `new NextRequest(...)` carrying a small streamed body. Cases: unsupported extension → 400; body over cap via `content-length` header → 400; happy path writes the file under a temp `UPLOADS_DIR` (set `process.env.UPLOADS_DIR` to a mkdtemp dir), creates the row, returns `id`/`objectKey`/`status:'pending'`; text file triggers `processFileForRAG` and `markFileReady` when it resolves `true`; an mp3 does NOT call `processFileForRAG`.
- [ ] **Step 2: Run to verify failure.** `bunx vitest run app/api/upload` → FAIL.
- [ ] **Step 3: Implement route + `UploadedFile` type fields + chat-panel client change** (code above).
- [ ] **Step 4: Run tests + full suite** — `bunx vitest run app/api/upload && bun run test` → PASS; `bun typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(uploads): streamed 2GB uploads, broad allowlist, file rows, fast path"`

---

### Task 4: Token-authed ingest job API

**Files:**
- Create: `lib/utils/ingest-auth.ts`
- Create: `app/api/ingest/claim/route.ts`, `app/api/ingest/file/[id]/route.ts`, `app/api/ingest/progress/route.ts`, `app/api/ingest/complete/route.ts`
- Test: `app/api/ingest/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: all Task 1 actions; `storeExtractedChunks` (Task 2); `chunksFilePath` unused here.
- Produces (worker contract, Tasks 8–10):
  - `POST /api/ingest/claim` → `200 { fileId, filename, mediaType, size }` | `204`
  - `GET /api/ingest/file/:id` → file bytes stream | 404
  - `POST /api/ingest/progress { fileId, stage }` → `200 { ok: true }`
  - `POST /api/ingest/complete { fileId, chunks?, error?, retryable? }` → `200 { status: 'ready' | 'pending' | 'failed' }`; 503 if embedding fails (worker retries)

`lib/utils/ingest-auth.ts`:

```ts
import crypto from 'node:crypto'

// Fail-closed bearer gate for the ingestion worker API. Mirrors the
// reranker service's auth: unset token means the feature is OFF (503),
// and comparison is constant-time.
export function checkIngestAuth(
  authorization: string | null
): { ok: true } | { ok: false; status: 503 | 401 } {
  const token = process.env.INGEST_API_TOKEN
  if (!token) return { ok: false, status: 503 }
  const expected = Buffer.from(`Bearer ${token}`)
  const got = Buffer.from(authorization ?? '')
  if (
    got.length !== expected.length ||
    !crypto.timingSafeEqual(got, expected)
  ) {
    return { ok: false, status: 401 }
  }
  return { ok: true }
}
```

`app/api/ingest/claim/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'

import { claimNextIngestJob } from '@/lib/db/file-actions'
import { checkIngestAuth } from '@/lib/utils/ingest-auth'

export async function POST(req: NextRequest) {
  const auth = checkIngestAuth(req.headers.get('authorization'))
  if (!auth.ok) return new NextResponse(null, { status: auth.status })
  const job = await claimNextIngestJob()
  if (!job) return new NextResponse(null, { status: 204 })
  return NextResponse.json({
    fileId: job.id,
    filename: job.filename,
    mediaType: job.mediaType,
    size: job.size
  })
}
```

`app/api/ingest/file/[id]/route.ts`:

```ts
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { Readable } from 'node:stream'

import { db } from '@/lib/db'
import { files } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { checkIngestAuth } from '@/lib/utils/ingest-auth'

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = checkIngestAuth(req.headers.get('authorization'))
  if (!auth.ok) return new NextResponse(null, { status: auth.status })
  const { id } = await params
  const rows = await db.select().from(files).where(eq(files.id, id)).limit(1)
  const row = rows[0]
  if (!row?.objectKey) return new NextResponse(null, { status: 404 })
  const abs = path.join(UPLOADS_DIR, row.objectKey)
  if (!abs.startsWith(UPLOADS_DIR + path.sep))
    return new NextResponse(null, { status: 400 })
  try {
    const info = await stat(abs)
    return new NextResponse(Readable.toWeb(createReadStream(abs)) as any, {
      headers: {
        'content-type': row.mediaType,
        'content-length': String(info.size)
      }
    })
  } catch {
    return new NextResponse(null, { status: 404 })
  }
}
```

`app/api/ingest/progress/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'

import { updateIngestProgress } from '@/lib/db/file-actions'
import { checkIngestAuth } from '@/lib/utils/ingest-auth'

export async function POST(req: NextRequest) {
  const auth = checkIngestAuth(req.headers.get('authorization'))
  if (!auth.ok) return new NextResponse(null, { status: auth.status })
  const { fileId, stage } = await req.json()
  if (typeof fileId !== 'string' || typeof stage !== 'string')
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  const ok = await updateIngestProgress(fileId, stage.slice(0, 64))
  return NextResponse.json({ ok })
}
```

`app/api/ingest/complete/route.ts`:

```ts
import path from 'node:path'
import { NextRequest, NextResponse } from 'next/server'

import {
  completeIngestFailure,
  findFileByObjectKey,
  markFileReady
} from '@/lib/db/file-actions'
import { db } from '@/lib/db'
import { files } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { storeExtractedChunks } from '@/lib/embeddings/upload-rag'
import { checkIngestAuth } from '@/lib/utils/ingest-auth'

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'
const MAX_CHUNKS = 2000

export async function POST(req: NextRequest) {
  const auth = checkIngestAuth(req.headers.get('authorization'))
  if (!auth.ok) return new NextResponse(null, { status: auth.status })

  const body = await req.json()
  const { fileId, chunks, error, retryable } = body as {
    fileId?: string
    chunks?: string[]
    error?: string
    retryable?: boolean
  }
  if (typeof fileId !== 'string')
    return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const rows = await db.select().from(files).where(eq(files.id, fileId)).limit(1)
  const row = rows[0]
  if (!row?.objectKey)
    return NextResponse.json({ error: 'unknown file' }, { status: 404 })

  if (error || !Array.isArray(chunks) || chunks.length === 0) {
    const status = await completeIngestFailure(
      fileId,
      (error ?? 'worker returned no content').slice(0, 500),
      Boolean(retryable)
    )
    return NextResponse.json({ status })
  }

  if (chunks.length > MAX_CHUNKS)
    return NextResponse.json({ error: 'too many chunks' }, { status: 400 })

  try {
    const abs = path.join(UPLOADS_DIR, row.objectKey)
    await storeExtractedChunks(abs, row.filename, chunks)
  } catch (e) {
    // Embedder down — tell the worker to retry completion later; the job
    // stays claimed and its heartbeat keeps it from stale-requeueing.
    console.error('[ingest/complete] embed/store failed:', e)
    return new NextResponse(null, { status: 503 })
  }
  await markFileReady(fileId)
  return NextResponse.json({ status: 'ready' })
}
```

- [ ] **Step 1: Write failing tests** — `app/api/ingest/__tests__/routes.test.ts`: token unset → 503 on all four; wrong token → 401; claim empty → 204; claim with job → JSON shape; progress bad body → 400; complete with `error, retryable:true` → passes `true` to `completeIngestFailure` and returns its status; complete happy path calls `storeExtractedChunks` with the absolute path + `markFileReady`; complete with `storeExtractedChunks` throwing → 503 and NO `markFileReady`; complete with 2001 chunks → 400. Mock `@/lib/db/file-actions`, `@/lib/db`, `@/lib/embeddings/upload-rag`; drive handlers directly with `NextRequest` and `vi.stubEnv('INGEST_API_TOKEN', 't')`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** (code above).
- [ ] **Step 4: Run tests + typecheck** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(uploads): token-authed ingest job API (claim/file/progress/complete)"`

---

### Task 5: Status-aware `transform-file-parts`

**Files:**
- Modify: `lib/streaming/helpers/transform-file-parts.ts`
- Test: `lib/streaming/helpers/__tests__/transform-file-parts.test.ts` (new)

**Interfaces:**
- Consumes: `findFileByObjectKey` (Task 1); existing `queryFileChunks`.
- Behavior contract (verbatim strings used by tests):
  - pending/processing → `[Attached file: NAME — still being processed (STAGE). Its content is not available yet; tell the user to ask again shortly.]` where STAGE falls back to `queued`.
  - failed → `[Attached file: NAME — processing failed: REASON.]`
  - missing on disk → `[Attached file: NAME — file is no longer available.]`
  - ready non-image with chunks → excerpts injection exactly like today's PDF branch; ready image → excerpts text part (if chunks exist) PLUS the base64 file part.

Implementation outline (replace `transformPart`):

```ts
function objectKeyFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!parsed.pathname.startsWith('/uploads/')) return null
    return decodeURIComponent(parsed.pathname.slice('/uploads/'.length))
  } catch {
    return null
  }
}

async function transformPart(part: any, userQuery: string): Promise<any[]> {
  if (part.type !== 'file') return [part]
  const localPath = urlToLocalPath(part.url)
  const objectKey = objectKeyFromUrl(part.url)
  if (!localPath || !objectKey) return [part]
  const filename = part.filename || path.basename(localPath)

  const row = objectKey ? await findFileByObjectKey(objectKey) : null
  const status = row?.status ?? 'ready' // pre-feature files have no row

  if (status === 'pending' || status === 'processing') {
    const stage = row?.ingestStage || 'queued'
    return [
      {
        type: 'text',
        text: `[Attached file: ${filename} — still being processed (${stage}). Its content is not available yet; tell the user to ask again shortly.]`
      }
    ]
  }
  if (status === 'failed') {
    return [
      {
        type: 'text',
        text: `[Attached file: ${filename} — processing failed: ${row?.ingestError ?? 'unknown error'}.]`
      }
    ]
  }

  if (!(await fileExists(localPath)))
    return [
      {
        type: 'text',
        text: `[Attached file: ${filename} — file is no longer available.]`
      }
    ]

  const query = userQuery || filename
  const result = await queryFileChunks(localPath, query, 10)

  if (part.mediaType?.startsWith('image/')) {
    const out: any[] = []
    if (result) {
      out.push({
        type: 'text',
        text: `[Attached image: ${filename}]\n\nExtracted content:\n\n${result.chunks.join('\n\n---\n\n')}`
      })
    }
    try {
      const buf = await fs.readFile(localPath)
      out.push({
        ...part,
        url: `data:${part.mediaType};base64,${buf.toString('base64')}`
      })
    } catch {
      /* keep text-only */
    }
    return out.length ? out : []
  }

  if (result) {
    return [
      {
        type: 'text',
        text: `[Attached document: ${filename}]\n\nRelevant excerpts:\n\n${result.chunks.join('\n\n---\n\n')}`
      }
    ]
  }

  // Ready but no chunks (pre-feature PDF fallback): keep today's pdftotext
  // full-text fallback for application/pdf, else an honest note.
  // (Preserve the existing pdftotext fallback block here unchanged.)
  ...
  return [
    {
      type: 'text',
      text: `[Attached file: ${filename}]\n\n(Could not extract content.)`
    }
  ]
}
```

- [ ] **Step 1: Write failing tests** covering every contract bullet (mock `@/lib/db/file-actions.findFileByObjectKey` per case, mock `@/lib/embeddings/upload-rag.queryFileChunks`, temp files on disk for the exists/base64 paths).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run new file + full suite + typecheck** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(uploads): status-aware, all-type attachment injection"`

---

### Task 6: Status polling API + attachment chip UI

**Files:**
- Create: `app/api/files/status/route.ts`
- Modify: `components/uploaded-file-list.tsx` (status affordance + polling)
- Modify: `components/chat-panel.tsx` (thread `ingestStatus`/`id`/`objectKey` through `UploadedFile` state; poll only while any file is pending/processing)
- Test: `app/api/files/__tests__/status.test.ts`, extend `components/__tests__/chat-panel.test.tsx` if the chip logic lands there

**Interfaces:**
- Consumes: `getFileStatusesForUser` (Task 1).
- Produces: `GET /api/files/status?keys=<comma-separated objectKeys>` (session-authed) → `{ statuses: Array<{ objectKey, status, ingestStage, ingestError }> }`.

Route:

```ts
import { NextRequest, NextResponse } from 'next/server'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { getFileStatusesForUser } from '@/lib/db/file-actions'

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId()
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const keys = (req.nextUrl.searchParams.get('keys') ?? '')
    .split(',')
    .map(k => decodeURIComponent(k))
    .filter(Boolean)
    .slice(0, 20)
  const statuses = await getFileStatusesForUser(userId, keys)
  return NextResponse.json({ statuses })
}
```

Chip behavior in `uploaded-file-list.tsx`: each entry renders its filename plus — when `ingestStatus` is `pending`/`processing` — a `Spinner` with `title={ingestStage ?? 'queued'}`; when `failed`, a red `X` icon with `title={ingestError}`. `chat-panel.tsx` runs a 5s `setInterval` effect that fires only while `uploadedFiles.some(f => f.ingestStatus === 'pending' || f.ingestStatus === 'processing')`, calls the status route with those files' objectKeys, and merges results into state; interval cleans up on unmount and stops when nothing is in flight.

- [ ] **Step 1: Write failing tests** — status route: 401 unauthenticated; filters through `getFileStatusesForUser(userId, keys)`; caps at 20 keys. Chip: render `UploadedFileList` with a processing file → spinner present with stage tooltip; failed file → error affordance with reason.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests + full suite + typecheck** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(uploads): file status API and attachment status chips"`

---

### Task 7: model-manager registry + env plumbing

**Files:**
- Modify: `selfhosted/model-manager/lib/env-schema.ts` (new `Ingestion` group in `models`)
- Modify: `.env` (staging/prod add `INGEST_API_TOKEN=<openssl rand -hex 32>` — value generated at deploy time, not committed)

**Interfaces:** none downstream; mm tests must stay green.

- [ ] **Step 1: Add the registry entry** after the Reranker group:

```ts
  // ---------- Models: Ingestion ----------
  {
    key: 'INGEST_API_TOKEN',
    category: 'models',
    group: 'Ingestion',
    label: 'Ingestion worker token',
    type: 'secret',
    target: 'ask',
    help: 'Bearer token the uploads-ingestion worker uses against /api/ingest/*. Unset disables worker ingestion (uploads queue as pending; text documents still fast-path locally).'
  },
```

- [ ] **Step 2: Run mm suite** — `cd selfhosted/model-manager && bun typecheck && bun run test` → PASS.
- [ ] **Step 3: Commit** — `git commit -m "feat(uploads): INGEST_API_TOKEN in model-manager registry"`

---

### Task 8: Worker scaffold — config, Ask client, chunking, VLM client, poll loop

**Files (all NEW, under `/home/nightfury/selfhosted/ingestor/` — not in the ask repo):**
- `Dockerfile`, `docker-compose.yaml`, `.env.example`, `requirements.txt`
- `app/config.py`, `app/ask_client.py`, `app/chunking.py`, `app/vlm.py`, `app/worker.py`
- `tests/test_chunking.py`, `tests/test_dispatch.py`

**Interfaces:**
- Consumes: the Task 4 HTTP contract verbatim.
- Produces (used by Task 9 extractors): `config.settings` (env-driven), `ask_client.AskClient` with `claim() -> dict | None`, `download(file_id, dest_path)`, `progress(file_id, stage)`, `complete_success(file_id, chunks: list[str])` (retries on 503 with 30s backoff, heartbeating between tries), `complete_failure(file_id, error: str, retryable: bool)`; `chunking.timestamp_prefix(start_s: float, end_s: float) -> str` (returns `[HH:MM:SS–HH:MM:SS] `), `chunking.merge_timed_segments(segments: list[tuple[float, float, str]], window_s=120) -> list[str]`; `vlm.describe_image(png_path: str, prompt: str) -> str` (serialized by a global `threading.Lock`, temperature 0, calls `OLLAMA_URL /api/chat` with the base64 image); `worker.EXTRACTORS: dict[str, callable]` dispatch registry keyed by family (`document|image|audio|video|pdf`), `worker.family_for(media_type: str, filename: str) -> str`.

Key file contents:

`Dockerfile`:

```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    pandoc libreoffice poppler-utils ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
CMD ["python", "-m", "app.worker"]
```

`requirements.txt`:

```
requests==2.32.3
faster-whisper==1.1.1
```

`docker-compose.yaml` (CPU only; ollama + Ask reached over the LAN/host):

```yaml
# Uploads-ingestion worker for Ask, on NightFuryX. CPU-only container —
# the VLM runs in the host's ollama (pinned to the GTX 1070 by UUID).
name: ingestor
services:
  ingestor:
    build: .
    container_name: ingestor
    env_file: .env
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - whisper-cache:/root/.cache/huggingface
    restart: unless-stopped
volumes:
  whisper-cache:
    name: ingestor-whisper-cache
```

`.env.example`:

```
ASK_URL=http://192.168.50.231:3738
INGEST_API_TOKEN=
OLLAMA_URL=http://host.docker.internal:11434
VLM_MODEL=qwen3-vl:4b
WHISPER_MODEL=large-v3
MAX_VIDEO_FRAMES=40
JOB_CONCURRENCY=2
```

`app/chunking.py`:

```python
def _hms(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


def timestamp_prefix(start_s: float, end_s: float) -> str:
    return f"[{_hms(start_s)}–{_hms(end_s)}] "


def merge_timed_segments(segments, window_s: float = 120.0) -> list[str]:
    """Merge (start, end, text) segments into ~window_s chunks, each
    prefixed with its covered range."""
    chunks: list[str] = []
    cur_texts: list[str] = []
    cur_start = cur_end = None
    for start, end, text in segments:
        text = text.strip()
        if not text:
            continue
        if cur_start is None:
            cur_start, cur_end = start, end
        cur_texts.append(text)
        cur_end = end
        if cur_end - cur_start >= window_s:
            chunks.append(timestamp_prefix(cur_start, cur_end) + " ".join(cur_texts))
            cur_texts, cur_start, cur_end = [], None, None
    if cur_texts:
        chunks.append(timestamp_prefix(cur_start, cur_end) + " ".join(cur_texts))
    return chunks
```

`app/worker.py` core loop (threads, honest error paths):

```python
import concurrent.futures
import tempfile
import time
import traceback
from pathlib import Path

from .ask_client import AskClient, RetryableError
from .config import settings
from .extractors import audio, documents, image_ocr, video

EXTRACTORS = {
    "document": documents.extract,
    "pdf": documents.extract_pdf,   # includes rasterize→VLM when no text layer
    "image": image_ocr.extract,
    "audio": audio.extract,
    "video": video.extract,
}


def family_for(media_type: str, filename: str) -> str:
    if media_type == "application/pdf":
        return "pdf"
    if media_type.startswith("image/"):
        return "image"
    if media_type.startswith("audio/"):
        return "audio"
    if media_type.startswith("video/"):
        return "video"
    return "document"


def run_job(client: AskClient, job: dict) -> None:
    file_id = job["fileId"]
    try:
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td) / job["filename"]
            client.progress(file_id, "downloading")
            client.download(file_id, dest)
            family = family_for(job["mediaType"], job["filename"])
            chunks = EXTRACTORS[family](dest, job, client)
            client.complete_success(file_id, chunks)
    except RetryableError as e:
        client.complete_failure(file_id, str(e)[:400], retryable=True)
    except Exception as e:
        traceback.print_exc()
        client.complete_failure(file_id, str(e)[:400], retryable=False)


def main() -> None:
    client = AskClient()
    pool = concurrent.futures.ThreadPoolExecutor(settings.job_concurrency)
    pending: set = set()
    while True:
        pending = {f for f in pending if not f.done()}
        job = client.claim() if len(pending) < settings.job_concurrency else None
        if job:
            pending.add(pool.submit(run_job, client, job))
            continue
        time.sleep(settings.poll_interval)


if __name__ == "__main__":
    main()
```

`app/vlm.py`:

```python
import base64
import threading

import requests

from .config import settings

_LOCK = threading.Lock()  # one VLM call at a time — 8GB card


class VlmError(Exception):
    pass


def describe_image(png_path, prompt: str) -> str:
    with open(png_path, "rb") as f:
        img = base64.b64encode(f.read()).decode()
    with _LOCK:
        r = requests.post(
            f"{settings.ollama_url}/api/chat",
            json={
                "model": settings.vlm_model,
                "stream": False,
                "options": {"temperature": 0},
                "messages": [
                    {"role": "user", "content": prompt, "images": [img]}
                ],
            },
            timeout=600,
        )
    if r.status_code != 200:
        raise VlmError(f"ollama HTTP {r.status_code}")
    return r.json()["message"]["content"]
```

`app/ask_client.py` implements the four endpoints with `requests`, bearer header, `claim()` returning `None` on 204, `download` streaming to disk, and `complete_success` looping on 503: sleep 30s, call `progress(file_id, "embedding")` as heartbeat, retry (max 20 tries → raise `RetryableError`). `RetryableError` is defined here and raised for connection errors + 5xx from ollama-dependent extractors.

- [ ] **Step 1: Write failing tests** — `tests/test_chunking.py` (`timestamp_prefix(0, 754) == "[00:00:00–00:12:34] "`; merge splits at the 120s window; empty segments skipped) and `tests/test_dispatch.py` (`family_for` for pdf/png/mp3/mp4/docx→document; `run_job` with a stub client: extractor raising `RetryableError` → `complete_failure(..., retryable=True)`, generic exception → `retryable=False`, success → `complete_success` with chunks).
- [ ] **Step 2: Run to verify failure** — `cd /home/nightfury/selfhosted/ingestor && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest && .venv/bin/pytest` → FAIL.
- [ ] **Step 3: Implement all scaffold files** (code above + `config.py` reading the env names from Global Constraints with those defaults + `ask_client.py`).
- [ ] **Step 4: Run tests** — `.venv/bin/pytest` → PASS (extractor modules may be import-stubs returning `NotImplementedError` until Task 9; keep dispatch tests on stubs via monkeypatch).
- [ ] **Step 5: No git repo here** — the service dir is unversioned like reranker-qwen/embedder; record completion in the plan checkboxes instead of a commit.

---

### Task 9: Worker extractors (documents, pdf-OCR, image, audio, video)

**Files:**
- Create: `app/extractors/__init__.py`, `documents.py`, `image_ocr.py`, `audio.py`, `video.py`
- Test: extend `tests/test_dispatch.py` with per-extractor unit tests (subprocess + VLM + whisper mocked via monkeypatch)

**Interfaces:**
- Every extractor: `extract(path: Path, job: dict, client: AskClient) -> list[str]` (raises `RetryableError` for transient causes, any other exception = permanent). `documents.extract_pdf` same signature.
- Consumes: `vlm.describe_image`, `chunking.*`, `client.progress`.

`documents.py`:

```python
import csv
import subprocess
from pathlib import Path

from ..chunking import merge_timed_segments  # noqa: F401 (audio/video use)
from ..vlm import describe_image

PANDOC_EXTS = {".docx", ".epub", ".html", ".htm", ".md"}
MAX_OCR_PAGES = 200


def _run(cmd: list[str], timeout: int = 300) -> str:
    out = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if out.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {out.stderr.decode()[:200]}")
    return out.stdout.decode("utf-8", errors="replace")


def extract(path: Path, job: dict, client) -> list[str]:
    client.progress(job["fileId"], "parsing")
    ext = path.suffix.lower()
    if ext in PANDOC_EXTS:
        text = _run(["pandoc", "-t", "plain", str(path)])
    elif ext == ".csv":
        with open(path, newline="", encoding="utf-8", errors="replace") as f:
            rows = list(csv.reader(f))
        text = "\n".join(", ".join(r) for r in rows)
    elif ext in {".xlsx", ".pptx"}:
        # libreoffice converts to a text-extractable intermediate
        _run([
            "libreoffice", "--headless", "--convert-to",
            "csv" if ext == ".xlsx" else "pdf",
            "--outdir", str(path.parent), str(path),
        ], timeout=600)
        produced = path.with_suffix(".csv" if ext == ".xlsx" else ".pdf")
        if produced.suffix == ".csv":
            text = produced.read_text(encoding="utf-8", errors="replace")
        else:
            text = _run(["pdftotext", "-layout", str(produced), "-"])
    else:  # txt/code and anything else text-like
        text = path.read_text(encoding="utf-8", errors="replace")
    text = text.strip()
    if len(text) < 20:
        raise RuntimeError("no extractable text")
    return _split(text)


def _split(text: str, size: int = 1800, overlap: int = 200) -> list[str]:
    chunks, i = [], 0
    while i < len(text):
        chunks.append(text[i : i + size])
        i += size - overlap
    return chunks


def extract_pdf(path: Path, job: dict, client) -> list[str]:
    client.progress(job["fileId"], "parsing")
    try:
        text = _run(["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"]).strip()
    except RuntimeError:
        text = ""
    if len(text) > 200:
        return _split(text)

    # No text layer: rasterize and read each page with the VLM.
    client.progress(job["fileId"], "ocr")
    pages_dir = path.parent / "pages"
    pages_dir.mkdir(exist_ok=True)
    _run(["pdftoppm", "-r", "150", "-png", str(path), str(pages_dir / "p")], timeout=1200)
    pages = sorted(pages_dir.glob("p*.png"))
    if len(pages) > MAX_OCR_PAGES:
        raise RuntimeError(f"scanned PDF has {len(pages)} pages (cap {MAX_OCR_PAGES})")
    out = []
    for n, page in enumerate(pages, 1):
        client.progress(job["fileId"], f"ocr page {n}/{len(pages)}")
        out.append(
            f"[page {n}]\n"
            + describe_image(
                page,
                "Transcribe this page verbatim. Briefly describe any figures.",
            )
        )
    return out
```

`image_ocr.py`:

```python
from pathlib import Path

from ..vlm import describe_image


def extract(path: Path, job: dict, client) -> list[str]:
    client.progress(job["fileId"], "reading image")
    text = describe_image(
        path,
        "Transcribe any text in this image verbatim, then describe the image "
        "(charts: report every value; UI: name the visible elements).",
    )
    return [text]
```

`audio.py`:

```python
from pathlib import Path

from ..chunking import merge_timed_segments
from ..config import settings


def extract(path: Path, job: dict, client) -> list[str]:
    client.progress(job["fileId"], "transcribing")
    from faster_whisper import WhisperModel

    model = WhisperModel(settings.whisper_model, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(str(path))
    timed = [(s.start, s.end, s.text) for s in segments]
    chunks = merge_timed_segments(timed)
    if not chunks:
        raise RuntimeError("no speech found")
    return chunks
```

`video.py`:

```python
import subprocess
from pathlib import Path

from ..chunking import timestamp_prefix
from ..config import settings
from ..vlm import describe_image
from . import audio as audio_extractor


def extract(path: Path, job: dict, client) -> list[str]:
    # 1. Audio track → whisper (reuse the audio extractor on the demuxed wav).
    wav = path.with_suffix(".wav")
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000", str(wav)],
        capture_output=True, timeout=1800,
    )
    chunks: list[str] = []
    if wav.exists() and wav.stat().st_size > 44:
        chunks.extend(audio_extractor.extract(wav, job, client))

    # 2. Scene-detected keyframes → VLM captions (capped).
    client.progress(job["fileId"], "frames")
    frames_dir = path.parent / "frames"
    frames_dir.mkdir(exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(path),
         "-vf", "select='gt(scene,0.3)',showinfo", "-vsync", "vfr",
         "-frame_pts", "1", str(frames_dir / "f%d.png")],
        capture_output=True, timeout=1800,
    )
    frames = sorted(frames_dir.glob("f*.png"),
                    key=lambda p: int(p.stem[1:]))[: settings.max_video_frames]
    for f in frames:
        # -frame_pts names files by presentation timestamp (in stream
        # timebase seconds when vsync vfr + pts naming is used).
        ts = int(f.stem[1:])
        caption = describe_image(f, "Describe this video frame in one sentence.")
        chunks.append(timestamp_prefix(ts, ts) + f"[frame] {caption}")
    if not chunks:
        raise RuntimeError("no audio and no frames extracted")
    return chunks
```

- [ ] **Step 1: Write failing extractor tests** (monkeypatch `subprocess.run`/`describe_image`/`WhisperModel`): documents dispatches pandoc for `.docx` and reads csv inline; `extract_pdf` returns split text when pdftotext yields >200 chars and calls `describe_image` per rasterized page otherwise (fake `pdftoppm` by creating `pages/p1.png`); image extractor returns a single chunk; audio raises on empty segments; video caps frames at `settings.max_video_frames`.
- [ ] **Step 2: Run to verify failure**, then **Step 3: implement** (code above), **Step 4: `.venv/bin/pytest` → PASS.**
- [ ] **Step 5: Build the container locally** — `docker compose build` on `.231` → succeeds.

---

### Task 10: Deploy worker to NightFuryX + staging end-to-end

**Files:** none new — deployment + verification.

- [ ] **Step 1: Generate the token and wire both sides (staging first)** — `openssl rand -hex 32`; add `INGEST_API_TOKEN=<value>` to `ask/.env`; rebuild the **staging** stack (`docker compose -p ask-stack-admin-feature … up -d --build ask`); run staging migration (`docker exec ask-admin-feature bun migrate`).
- [ ] **Step 2: Deploy the worker** — `scp -r /home/nightfury/selfhosted/ingestor nightfury@192.168.50.169:/home/nightfury/selfhosted/`; create `.env` there with `ASK_URL=http://192.168.50.231:3739` (staging), the token, and the defaults; `docker compose up -d --build`; verify logs show idle polling (`docker logs ingestor` → repeated 204 claims, no errors).
- [ ] **Step 3: E2E per family on staging** (UI at :3739): upload one docx, one scanned/image file, one mp3, one short mp4, one large txt. Verify for each: chip spinner with stage → ready; then ask a content question in the chat and confirm the answer uses the extracted content. Verify the txt went ready in seconds via the fast path (worker logs never saw it).
- [ ] **Step 4: Sleeping-node E2E** — `docker stop ingestor`; upload an mp3 → chip stays queued; send a question → answer honestly reports still-processing; `docker start ingestor` → job drains to ready; re-ask → answered from the transcript.
- [ ] **Step 5: Failure E2E** — upload a corrupt `.docx` (e.g. rename a txt) → status failed, chip tooltip shows the reason, answer injection reports it.
- [ ] **Step 6: Full Ask suite + build** — `bun run test && bun typecheck && bun lint && bun format:check` all green.

**Production rollout is NOT part of this plan** — after review, ask the user; the prod steps are the standard workflow plus `bun migrate` on prod and repointing the worker's `ASK_URL` to :3738.

---

## Self-review notes (completed)

- Spec coverage: every spec section maps to a task (data model→1, upload/fast path→2+3, job API→4, answer-time→5, UI→6, config→7, worker→8+9, failure handling→1/4/8, testing→per-task + 10). Chunk-cap, page-cap, frame-cap, stale/attempts values match the spec constants.
- The `/complete` 503-retry loop heartbeats via `progress` (ask_client contract) so the claim never goes stale mid-retry — matches the spec's failure table.
- Type consistency: `objectKey` is the URL↔row join key everywhere (Tasks 1, 3, 5, 6); `retryable` boolean flows worker→complete→completeIngestFailure.
- Known simplification (accepted): video frame timestamps derive from ffmpeg `-frame_pts` naming, which is approximate for odd timebases; captions are still ordered and usable.
