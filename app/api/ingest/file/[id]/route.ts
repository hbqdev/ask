import { NextRequest, NextResponse } from 'next/server'

import { eq } from 'drizzle-orm'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

import { db } from '@/lib/db'
import { libraryFiles as files } from '@/lib/db/schema'
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
