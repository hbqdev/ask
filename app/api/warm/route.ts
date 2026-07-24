import { NextResponse } from 'next/server'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { buildWarmRequests, shouldWarm } from '@/lib/warm/build-warm-requests'

// Demand-triggered GPU warm-up. The client calls this while the user is
// actually composing, so the support GPUs ramp out of P8 before a prompt is
// sent — instead of a 24/7 keep-warm loop burning ~37W to serve a handful of
// first-turns a day. See lib/warm/build-warm-requests.ts for the measurements.

// Measured on the P5000: ONE ping holds P0 for ~14-15s, then the clock falls
// back (P5 by +16s). The ~45s decay figure applies only to a GPU held at P0 by
// sustained traffic — it does not describe a single ping. So the window has to
// sit under that ~15s hold, or a composing user goes cold between pings.
const WARM_THROTTLE_MS = 10_000
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

  // These MUST be awaited. An unawaited fetch here is torn down when the
  // handler returns, so the pings never reach the GPU — the endpoint answers
  // 204 while doing nothing, which is exactly how this shipped broken the
  // first time. They run concurrently and settle in ~0.5s, and the client
  // never blocks on this response anyway.
  const pings = buildWarmRequests(process.env).map(req =>
    fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS)
    })
  )
  await Promise.allSettled(pings)

  return new NextResponse(null, { status: 204 })
}
