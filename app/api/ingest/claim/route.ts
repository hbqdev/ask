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
