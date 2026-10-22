import { after, NextRequest, NextResponse } from 'next/server'

import { eq } from 'drizzle-orm'
import path from 'node:path'

import { dbAdmin } from '@/lib/db'
import {
  completeIngestFailure,
  markProcessingFileReady,
  updateIngestProgress
} from '@/lib/db/file-actions'
import { libraryFiles as files } from '@/lib/db/schema'
import { storeExtractedChunks } from '@/lib/embeddings/upload-rag'
import { checkIngestAuth } from '@/lib/utils/ingest-auth'
import { readIngestCompleteBody } from '@/lib/utils/ingest-complete-body'

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'
// A file is indexed from at most its first MAX_CHUNKS chunks. A bigger one is
// not failed: it is indexed from those and marked ready with PARTIAL_NOTE,
// which the attachment UI shows.
const MAX_CHUNKS = 2000
const PARTIAL_NOTE = 'Indexed the first part only (file too large)'
// The most of a completion body that is read into memory: 2000 chunks of the
// worker's 1800 characters fit even fully \u-escaped (CJK), about 22 MB.
const MAX_BODY_BYTES = 24 * 1024 * 1024
// States a file never leaves through a completion: a duplicate one (worker
// retry, requeued job) for such a file is acknowledged and otherwise ignored.
const SETTLED = new Set(['ready', 'failed', 'expired'])
// Files whose chunks this process is embedding right now, so a duplicate
// completion arriving meanwhile does not start a second embed of the same file.
const embedding = new Set<string>()

// The reason an embed failure is shown to the user with (as ingestError).
function embedFailureReason(e: unknown): string {
  if (e instanceof Error && e.name === 'AbortError')
    return 'Could not index this file: the embedding service did not respond in time. Try uploading it again.'
  const detail = e instanceof Error ? e.message : String(e)
  return `Could not index this file: the embedding service failed (${detail}). Try uploading it again.`.slice(
    0,
    500
  )
}

// Embeds and stores the chunks, then settles the file: ready (with the
// partial note when only part of it was kept) or failed with a reason —
// never left 'processing'. Runs after the response, so it must not throw.
async function embedAndSettle(
  fileId: string,
  abs: string,
  filename: string,
  chunks: string[],
  partial: boolean
): Promise<void> {
  try {
    try {
      // Each finished batch refreshes the job's claim, so a long embed is not
      // mistaken for a dead worker and requeued while it runs.
      await storeExtractedChunks(abs, filename, chunks, () =>
        updateIngestProgress(fileId, 'embedding').catch(() => false)
      )
    } catch (e) {
      console.error('[ingest/complete] embed/store failed:', e)
      await completeIngestFailure(fileId, embedFailureReason(e), false)
      return
    }
    const ready = partial
      ? await markProcessingFileReady(fileId, PARTIAL_NOTE)
      : await markProcessingFileReady(fileId)
    if (!ready)
      console.warn(
        `[ingest/complete] ${fileId} was settled while it embedded; left as is`
      )
  } catch (e) {
    console.error('[ingest/complete] could not record the outcome:', e)
  } finally {
    embedding.delete(fileId)
  }
}

export async function POST(req: NextRequest) {
  const auth = checkIngestAuth(req.headers.get('authorization'))
  if (!auth.ok) return new NextResponse(null, { status: auth.status })

  const body = await readIngestCompleteBody(req, MAX_BODY_BYTES)
  if (!body)
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })

  const { fileId, chunks, error, retryable, truncated } = body as {
    fileId?: string
    chunks?: unknown[]
    error?: string
    retryable?: boolean
    truncated: boolean
  }
  if (typeof fileId !== 'string')
    return NextResponse.json({ error: 'bad request' }, { status: 400 })

  // Ingest is a machine endpoint with no user session, so look the file up with
  // the admin (RLS-bypassing) client — the restricted `db` sees zero rows
  // without an app.current_user_id and would 404 every completion.
  const rows = await dbAdmin
    .select()
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1)
  const row = rows[0]
  if (!row?.objectKey)
    return NextResponse.json({ error: 'unknown file' }, { status: 404 })
  if (SETTLED.has(row.status)) return NextResponse.json({ status: row.status })

  if (error || !Array.isArray(chunks) || chunks.length === 0) {
    // This process is embedding the file from an earlier completion (the
    // worker may have given up waiting and reported a failure): that embed
    // settles it, so a failure report must not flip it back to pending.
    if (embedding.has(fileId))
      return NextResponse.json({ status: 'processing' }, { status: 202 })
    const status = await completeIngestFailure(
      fileId,
      (error ?? 'worker returned no content').slice(0, 500),
      Boolean(retryable)
    )
    return NextResponse.json({ status })
  }

  const partial = truncated || chunks.length > MAX_CHUNKS
  const kept = chunks.slice(0, MAX_CHUNKS)

  if (!kept.every((c): c is string => typeof c === 'string'))
    return NextResponse.json(
      { error: 'chunks must be strings' },
      { status: 400 }
    )

  const abs = path.join(UPLOADS_DIR, row.objectKey)
  // Defense-in-depth: objectKey is DB-sourced (written by the upload route,
  // which sanitizes it) so it can't currently escape, but mirror the download
  // route's containment guard so a future write path can't turn this into a
  // path-traversal write.
  if (!abs.startsWith(UPLOADS_DIR + path.sep))
    return NextResponse.json({ error: 'invalid object key' }, { status: 400 })

  // Embedding up to MAX_CHUNKS chunks can take longer than the worker waits
  // for this response, so answer now and embed after it has been sent; the
  // file's status (polled by the UI) reports the outcome.
  if (!embedding.has(fileId)) {
    embedding.add(fileId)
    try {
      after(() => embedAndSettle(fileId, abs, row.filename, kept, partial))
    } catch (e) {
      embedding.delete(fileId)
      throw e
    }
  }
  return NextResponse.json({ status: 'processing' }, { status: 202 })
}
