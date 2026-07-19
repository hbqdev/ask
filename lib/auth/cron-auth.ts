import { NextResponse } from 'next/server'

import { createHash, timingSafeEqual } from 'crypto'

/** Constant-time compare that tolerates unequal lengths (digests are fixed-size). */
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * Authorize a cron-triggered maintenance route. Returns a response to send
 * immediately when the caller is NOT authorized, or null when it is.
 *
 * FAILS CLOSED when MEMORY_CRON_SECRET is unset. The previous per-route guard
 * was `if (secret && header !== bearer) return 401`, which fails OPEN: with no
 * secret configured the condition short-circuits and the route runs for
 * anyone. That is how it actually ran in production — a plain unauthenticated
 * POST triggered a full re-embed of every user's history. The routes behind
 * this helper rewrite or re-embed ALL users' data, so "not configured" must
 * mean "disabled", never "unguarded".
 *
 * 503 (not 401) when unconfigured: the caller isn't wrong, the deployment is.
 */
export function requireCronSecret(request: Request): NextResponse | null {
  const secret = process.env.MEMORY_CRON_SECRET
  if (!secret) {
    console.warn(
      '[cron] MEMORY_CRON_SECRET is not set — refusing the request. Set it to enable cron maintenance routes.'
    )
    return NextResponse.json(
      { error: 'cron secret not configured' },
      { status: 503 }
    )
  }

  const header = request.headers.get('authorization')
  if (!header || !secretsMatch(header, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return null
}
