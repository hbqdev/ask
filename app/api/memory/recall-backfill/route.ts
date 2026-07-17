import { NextResponse } from 'next/server'

import { requireCronSecret } from '@/lib/auth/cron-auth'
import { backfillAllUsers } from '@/lib/memory/recall-backfill'

export async function POST(request: Request) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  // `ok` reflects backfillAllUsers' honesty signal (see recall-backfill.ts):
  // false means at least one user's sweep hit a REAL error — it is no
  // longer flipped false just because some users have recall disabled
  // (that's an expected, non-error per-user outcome, counted separately in
  // `skipped`). `failed` counts the users behind an `ok: false`. Surfaced
  // here (not swallowed into a flat 200) so a caller polling this endpoint
  // can tell a quiet cron run apart from one that silently didn't work, and
  // can tell "some users opted out" apart from "something broke".
  const result = await backfillAllUsers()
  return NextResponse.json(result)
}
