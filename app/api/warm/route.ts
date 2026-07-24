import { NextResponse } from 'next/server'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { buildWarmRequests, shouldWarm } from '@/lib/warm/build-warm-requests'

// Demand-triggered GPU warm-up. The client calls this while the user is
// actually composing, so the support GPUs ramp out of P8 before a prompt is
// sent — instead of a 24/7 keep-warm loop burning ~37W to serve a handful of
// first-turns a day. See lib/warm/build-warm-requests.ts for the measurements.

// Measured P8 decay is ~45s of quiet, so a 30s window keeps a composing user
// warm while an abandoned session falls back to idle on its own.
const WARM_THROTTLE_MS = 30_000
const PING_TIMEOUT_MS = 8_000

let lastWarmedAt: number | null = null

export async function POST() {
  const userId = await getCurrentUserId()
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const now = Date.now()
  if (!shouldWarm(lastWarmedAt, now, WARM_THROTTLE_MS)) {
    return new NextResponse(null, { status: 204 })
  }
  lastWarmedAt = now

  // Fire-and-forget: the point is to START the clock ramp, not to wait for it.
  // A failed or slow ping is not an error worth surfacing — the turn itself
  // still works, just from a colder clock.
  for (const req of buildWarmRequests(process.env)) {
    fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS)
    }).catch(() => {})
  }

  return new NextResponse(null, { status: 204 })
}
