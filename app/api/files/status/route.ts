import { NextRequest, NextResponse } from 'next/server'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { getFileStatusesForUser } from '@/lib/db/file-actions'

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId()
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const keys = (req.nextUrl.searchParams.get('keys') ?? '')
    .split(',')
    .map(k => decodeURIComponent(k))
    .filter(Boolean)
    .slice(0, 20)
  const statuses = await getFileStatusesForUser(userId, keys)
  return NextResponse.json({ statuses })
}
