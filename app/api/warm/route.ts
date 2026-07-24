import { NextResponse } from 'next/server'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { buildWarmRequests, shouldWarm } from '@/lib/warm/build-warm-requests'

// Demand-triggered GPU warm-up. The client calls this while the user is
// actually composing, so the support GPUs ramp out of P8 before a prompt is
// sent — instead of a 24/7 keep-warm loop burning ~37W to serve a handful of
// first-turns a day. See lib/warm/build-warm-requests.ts for the measurements.

// Measured on the P5000: one ping holds P0 for ~6-15s, varying run to run.
// The ~45s decay figure applies only to a GPU held at P0 by sustained traffic
// and does NOT describe a single ping. The window sits under the SHORTEST hold
// observed (~6s), because a window longer than the hold opens a cold gap
// mid-compose — seen directly on staging at 10s.
const WARM_THROTTLE_MS = 5_000
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
  const started = Date.now()
  const targets = buildWarmRequests(process.env)
  const results = await Promise.allSettled(
    targets.map(req =>
      fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
        cache: 'no-store',
        signal: AbortSignal.timeout(PING_TIMEOUT_MS)
      })
    )
  )

  // One line per warm, mirroring the [latency] convention. Without this a
  // failing ping is invisible: allSettled swallows the reason and the route
  // still answers 204, which is precisely how the first version shipped
  // broken.
  const failures = results
    .map((r, i) =>
      r.status === 'rejected'
        ? `${new URL(targets[i].url).host}:${(r.reason as Error)?.message}`
        : null
    )
    .filter(Boolean)
  console.log(
    `[warm] ${JSON.stringify({
      targets: targets.length,
      ok: results.filter(r => r.status === 'fulfilled').length,
      failed: failures.length,
      ms: Date.now() - started,
      ...(failures.length ? { errors: failures } : {})
    })}`
  )

  return new NextResponse(null, { status: 204 })
}
