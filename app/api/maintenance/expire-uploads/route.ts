import { NextRequest, NextResponse } from 'next/server'

import { expireIdleUploads } from '@/lib/db/file-actions'
import { checkIngestAuth } from '@/lib/utils/ingest-auth'

export async function POST(req: NextRequest) {
  const auth = checkIngestAuth(req.headers.get('authorization'))
  if (!auth.ok) return new NextResponse(null, { status: auth.status })
  const summary = await expireIdleUploads()
  console.log('[expire-uploads]', JSON.stringify(summary))
  return NextResponse.json({ summary })
}
