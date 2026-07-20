// Job-state actions for the universal-uploads ingestion queue. These run
// as the SERVICE (no user session): the worker API routes call them with
// the raw db client, which as table owner bypasses RLS — the routes are
// gated by INGEST_API_TOKEN instead. getFileStatusesForUser is the one
// user-facing reader and filters by userId explicitly.
import type { InferSelectModel } from 'drizzle-orm'
import { and, eq, inArray, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
// The `files` table is exported as `libraryFiles` in schema.ts (its SQL
// table name is still "files"); alias on import so this module reads the
// way the rest of the codebase — and the ingestion plan — refers to it.
import { libraryFiles as files } from '@/lib/db/schema'

export type FileRow = InferSelectModel<typeof files>

const MAX_ATTEMPTS = 3
const STALE_CLAIM_MINUTES = 30

// `db.execute()` returns driver-shaped results. This project uses
// postgres-js, whose result IS the array of rows (`result[0]`); node-postgres
// returns `{ rows: [...] }`. Read both shapes so a driver swap can't silently
// break the ingestion queue.
function execRows(result: unknown): any[] {
  if (Array.isArray(result)) return result
  const maybe = (result as { rows?: unknown }).rows
  return Array.isArray(maybe) ? maybe : []
}

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
  const row = execRows(result)[0]
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
  return Boolean(execRows(result)[0])
}

export async function completeIngestFailure(
  id: string,
  error: string,
  retryable: boolean
): Promise<'pending' | 'failed'> {
  const current = await db.execute(
    sql`SELECT attempts FROM files WHERE id = ${id}`
  )
  const attempts = Number(execRows(current)[0]?.attempts ?? MAX_ATTEMPTS)
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
