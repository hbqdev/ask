import { NextResponse } from 'next/server'

import { consolidateAllActiveUsers } from '@/lib/agents/memory-consolidator'

export async function POST(request: Request) {
  const secret = process.env.MEMORY_CRON_SECRET
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const result = await consolidateAllActiveUsers()
  return NextResponse.json(result)
}
