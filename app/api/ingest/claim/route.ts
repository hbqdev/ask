import { NextRequest, NextResponse } from 'next/server'

import { claimNextIngestJob } from '@/lib/db/file-actions'
import { checkIngestAuth } from '@/lib/utils/ingest-auth'
import { recordIngestHeartbeat } from '@/lib/utils/ingest-heartbeat'

export async function POST(req: NextRequest) {
  const auth = checkIngestAuth(req.headers.get('authorization'))
  if (!auth.ok) return new NextResponse(null, { status: auth.status })
  // An authenticated claim poll (which the worker fires every ~15s, even when
  // idle) proves the worker is alive and consuming — record it so the answer
  // path can tell a down worker from a merely-slow one. Best-effort.
  await recordIngestHeartbeat()
  const job = await claimNextIngestJob()
  if (!job) return new NextResponse(null, { status: 204 })
  return NextResponse.json({
    fileId: job.id,
    filename: job.filename,
    mediaType: job.mediaType,
    size: job.size
  })
}
