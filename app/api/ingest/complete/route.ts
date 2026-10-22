import { NextRequest, NextResponse } from 'next/server'

import { eq } from 'drizzle-orm'
import path from 'node:path'

import { dbAdmin } from '@/lib/db'
import { completeIngestFailure, markFileReady } from '@/lib/db/file-actions'
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

  if (error || !Array.isArray(chunks) || chunks.length === 0) {
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

  try {
    await storeExtractedChunks(abs, row.filename, kept)
  } catch (e) {
    // Embedder down — tell the worker to retry completion later; the job
    // stays claimed and its heartbeat keeps it from stale-requeueing.
    console.error('[ingest/complete] embed/store failed:', e)
    return new NextResponse(null, { status: 503 })
  }
  if (partial) await markFileReady(fileId, PARTIAL_NOTE)
  else await markFileReady(fileId)
  return NextResponse.json({ status: 'ready' })
}
