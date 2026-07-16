import { NextResponse } from 'next/server'

import { backfillAllUsers } from '@/lib/memory/recall-backfill'

export async function POST(request: Request) {
  const secret = process.env.MEMORY_CRON_SECRET
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const result = await backfillAllUsers()
  return NextResponse.json(result)
}
