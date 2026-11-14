// Per-user cap on follow-up generations: each one is a classifier-model call,
// and the endpoint is reachable by any signed-in user. In-memory and
// per-process (the app runs as one process per stack); a restart clears it.

export const FOLLOWUP_RATE_LIMIT = 20
export const FOLLOWUP_RATE_WINDOW_MS = 60_000

// userId -> times (ms) of the generations in the current window, oldest first.
const recent = new Map<string, number[]>()
let lastSweep = 0

function sweep(now: number): void {
  for (const [userId, times] of recent) {
    if (times[times.length - 1] <= now - FOLLOWUP_RATE_WINDOW_MS) {
      recent.delete(userId)
    }
  }
  lastSweep = now
}

/**
 * Take a slot for `userId` in the rolling window: true when the request may
 * go ahead (and is counted), false when the user already made
 * FOLLOWUP_RATE_LIMIT requests in the last FOLLOWUP_RATE_WINDOW_MS. A refused
 * request is not counted.
 */
export function takeFollowupSlot(userId: string): boolean {
  const now = Date.now()
  // Drop users who went quiet, at most once per window, so the map stays
  // bounded by the users active in the last minute or so.
  if (now - lastSweep >= FOLLOWUP_RATE_WINDOW_MS) sweep(now)

  const cutoff = now - FOLLOWUP_RATE_WINDOW_MS
  const times = (recent.get(userId) ?? []).filter(t => t > cutoff)
  if (times.length >= FOLLOWUP_RATE_LIMIT) {
    recent.set(userId, times)
    return false
  }
  times.push(now)
  recent.set(userId, times)
  return true
}

/** Users currently tracked (for tests). */
export function trackedFollowupUsers(): number {
  return recent.size
}

/** Forget every user (for tests). */
export function resetFollowupRateLimit(): void {
  recent.clear()
  lastSweep = 0
}
