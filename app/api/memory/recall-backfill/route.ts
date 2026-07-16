import { NextResponse } from 'next/server'

import { backfillAllUsers } from '@/lib/memory/recall-backfill'

export async function POST(request: Request) {
  const secret = process.env.MEMORY_CRON_SECRET
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // `ok` reflects backfillUser's honesty signal (see recall-backfill.ts):
  // false means at least one user's sweep either hit a real error or was
  // skipped because recall is disabled for them — either way, `messages`/
  // `chunks` for that user cannot be read as "already up to date". Surfaced
  // here (not swallowed into a flat 200) so a caller polling this endpoint
  // can tell a quiet cron run apart from one that silently didn't work.
  const result = await backfillAllUsers()
  return NextResponse.json(result)
}
