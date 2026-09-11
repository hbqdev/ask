import { NextRequest, NextResponse } from 'next/server'

import { updateIngestProgress } from '@/lib/db/file-actions'
import { checkIngestAuth } from '@/lib/utils/ingest-auth'
import { recordIngestHeartbeat } from '@/lib/utils/ingest-heartbeat'

export async function POST(req: NextRequest) {
  const auth = checkIngestAuth(req.headers.get('authorization'))
  if (!auth.ok) return new NextResponse(null, { status: auth.status })
  // Progress reports fire several times per job, so this keeps the worker's
  // heartbeat fresh even while it is saturated and not polling /claim. Same
  // best-effort liveness signal as the claim route.
  await recordIngestHeartbeat()

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const { fileId, stage } = body as { fileId?: unknown; stage?: unknown }
  if (typeof fileId !== 'string' || typeof stage !== 'string')
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  const ok = await updateIngestProgress(fileId, stage.slice(0, 64))
  return NextResponse.json({ ok })
}
