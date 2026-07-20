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
