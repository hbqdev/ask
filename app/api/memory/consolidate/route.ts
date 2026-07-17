import { NextResponse } from 'next/server'

import { consolidateAllActiveUsers } from '@/lib/agents/memory-consolidator'
import { requireCronSecret } from '@/lib/auth/cron-auth'

export async function POST(request: Request) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const result = await consolidateAllActiveUsers()
  return NextResponse.json(result)
}
