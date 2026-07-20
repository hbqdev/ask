import { NextRequest, NextResponse } from 'next/server'

import { eq } from 'drizzle-orm'
import path from 'node:path'

import { db } from '@/lib/db'
import { completeIngestFailure, markFileReady } from '@/lib/db/file-actions'
import { libraryFiles as files } from '@/lib/db/schema'
import { storeExtractedChunks } from '@/lib/embeddings/upload-rag'
import { checkIngestAuth } from '@/lib/utils/ingest-auth'

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'
const MAX_CHUNKS = 2000

export async function POST(req: NextRequest) {
  const auth = checkIngestAuth(req.headers.get('authorization'))
  if (!auth.ok) return new NextResponse(null, { status: auth.status })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const { fileId, chunks, error, retryable } = body as {
    fileId?: string
    chunks?: unknown[]
    error?: string
    retryable?: boolean
  }
  if (typeof fileId !== 'string')
    return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const rows = await db
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

  if (chunks.length > MAX_CHUNKS)
    return NextResponse.json({ error: 'too many chunks' }, { status: 400 })

  if (!chunks.every((c): c is string => typeof c === 'string'))
    return NextResponse.json(
      { error: 'chunks must be strings' },
      { status: 400 }
    )

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
