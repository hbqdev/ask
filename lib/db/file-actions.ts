// Job-state actions for the universal-uploads ingestion queue. These run
// as the SERVICE (no user session): the worker API routes call them with
// the raw db client, which as table owner bypasses RLS — the routes are
// gated by INGEST_API_TOKEN instead. getFileStatusesForUser is the one
// user-facing reader and filters by userId explicitly.
import type { InferSelectModel } from 'drizzle-orm'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { db } from '@/lib/db'
// The `files` table is exported as `libraryFiles` in schema.ts (its SQL
// table name is still "files"); alias on import so this module reads the
// way the rest of the codebase — and the ingestion plan — refers to it.
import { libraryFiles as files } from '@/lib/db/schema'
import { chunksFilePath } from '@/lib/embeddings/upload-rag'

export type FileRow = InferSelectModel<typeof files>

const MAX_ATTEMPTS = 3
const STALE_CLAIM_MINUTES = 30
// Root under which every upload's bytes + its .chunks.json sidecar live; an
// object_key is joined onto this. Matches the ingestion worker + the RAG
// pipeline (both default to '/app/uploads' in the container).
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'

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

// Finalize jobs that reached the attempt cap via silent worker death: the
// worker claimed them (attempts++ to MAX_ATTEMPTS) but never reported back, so
// they sit status='processing' — excluded from the attempts<MAX requeue
// selector below, and thus stuck forever. Spec is "max 3 attempts → failed
// with reason", so sweep them to 'failed' once their claim goes stale. Runs at
// the start of every claim poll, so a stuck row is finalized within one stale
// window.
async function finalizeStuckJobs(): Promise<void> {
  await db.execute(sql`
    UPDATE files SET
      status = 'failed',
      ingest_error = 'retries exhausted',
      ingest_stage = NULL,
      claimed_at = NULL
    WHERE status = 'processing'
      AND attempts >= ${MAX_ATTEMPTS}
      AND claimed_at < now() - interval '${sql.raw(String(STALE_CLAIM_MINUTES))} minutes'
  `)
}

// Atomic claim: oldest pending job, or a stale processing job (worker
// crashed / box slept mid-run). FOR UPDATE SKIP LOCKED makes concurrent
// claims safe. Jobs at the attempt cap are finalized to failed by the
// finalizeStuckJobs sweep run first (below) and by completeIngestFailure;
// the claim query itself never selects rows with attempts >= MAX_ATTEMPTS.
export async function claimNextIngestJob(): Promise<{
  id: string
  filename: string
  mediaType: string
  size: number | null
  objectKey: string
} | null> {
  // Sweep stuck-at-cap rows to failed before claiming so they don't linger.
  await finalizeStuckJobs()
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

export interface ExpireSummary {
  expired: number
  bytesFreed: number
  scanned: number
  orphansRemoved: number
}

// Cap orphan deletions per sweep so a mis-derived key space or a large backlog
// can't turn one cron tick into an unbounded delete storm — the remainder is
// reclaimed on the next run. Hitting the cap is logged, never silently dropped.
const GC_DELETE_CAP = 500

function uploadTtlDays(): number {
  // Default 0 = disabled: the sweep is destructive, so operators must opt in
  // with a positive UPLOAD_TTL_DAYS (prod sets 14 explicitly). An unset,
  // zero, non-numeric, or non-positive value is a no-op.
  const n = Number(process.env.UPLOAD_TTL_DAYS ?? 0)
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
// ingests. Disabled by default: an unset, zero, or non-positive
// UPLOAD_TTL_DAYS is a no-op — operators opt in with a positive value.
export async function expireIdleUploads(): Promise<ExpireSummary> {
  const days = uploadTtlDays()
  if (days === 0)
    return { expired: 0, bytesFreed: 0, scanned: 0, orphansRemoved: 0 }

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

  // Second pass: reclaim bytes the row-driven sweep can't reach (rows already
  // hard-deleted, leaving their bytes behind). Only runs because days > 0 here,
  // so an un-opted-in operator never triggers a disk scan.
  const orphansRemoved = await gcOrphanUploads(days)

  return { expired, bytesFreed, scanned: rows.length, orphansRemoved }
}

// Reclaims on-disk bytes with no live `files` row — e.g. a chat was
// hard-deleted (row and all), orphaning its uploaded file + .chunks.json
// sidecar under UPLOADS_DIR. Walks the tree, derives each file's object_key
// relative to UPLOADS_DIR, and unlinks any file that (a) is older than the TTL
// AND (b) matches NO live row. Matching is STRICT on object_key: a file backing
// a live row is never touched, even if old. `.chunks.json` sidecars are skipped
// in the walk and only removed alongside their parent bytes. Deletions are
// capped per run (GC_DELETE_CAP) with a warning on truncation. Callers gate
// this behind days > 0 (see expireIdleUploads) so an unset UPLOAD_TTL_DAYS does
// nothing. Returns the number of files reaped.
export async function gcOrphanUploads(days: number): Promise<number> {
  // Defense-in-depth: this is the most destructive function here. With days <= 0
  // (or NaN) the age cutoff would collapse to "now" and reap every orphan
  // regardless of age. The only caller already gates on days > 0, but guard
  // internally so a future caller can't turn a bad `days` into a delete storm —
  // no query, no disk scan.
  if (!(days > 0)) return 0
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  // One query, then O(1) membership — avoids a DB round-trip per on-disk file.
  const result = await db.execute(
    sql`SELECT object_key FROM files WHERE object_key IS NOT NULL`
  )
  const live = new Set<string>(execRows(result).map(r => String(r.object_key)))

  let removed = 0
  let capHit = false

  async function walk(dir: string): Promise<void> {
    if (capHit) return
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch(() => null)
    if (!entries) return // dir missing / unreadable — nothing to reclaim
    for (const entry of entries) {
      if (capHit) return
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      // Sidecars are unlinked with their parent bytes, never on their own.
      if (entry.name.endsWith('.chunks.json')) continue
      const objectKey = path.relative(UPLOADS_DIR, abs)
      // Backs a live row — leave it, even if old. Checked before stat so a live
      // file is never even touched.
      if (live.has(objectKey)) continue
      const st = await fs.stat(abs).catch(() => null)
      if (!st) continue // vanished mid-walk
      if (st.mtimeMs >= cutoff) continue // still within the TTL window
      if (removed >= GC_DELETE_CAP) {
        capHit = true
        return
      }
      await unlinkQuietly(abs)
      await unlinkQuietly(chunksFilePath(abs))
      removed++
    }
  }

  await walk(UPLOADS_DIR)
  if (capHit) {
    console.warn(
      `[gcOrphanUploads] hit per-run deletion cap (${GC_DELETE_CAP}); ` +
        'remaining orphans will be reclaimed on the next sweep'
    )
  }
  return removed
}
