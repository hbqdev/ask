import { shouldWarm } from './build-warm-requests'

// Client-side half of the demand-triggered warm-up. Intent signals are noisy
// (every keystroke fires one), so the burst is collapsed here rather than
// letting the browser hammer /api/warm — the route throttles too, but there is
// no reason to spend a request per character.

// Matches the server window. One ping holds the GPU at P0 for only ~14-15s
// (measured), so a longer window would let a composing user go cold between
// keystrokes — the whole point is to be warm at send, not merely to have
// pinged at some point.
const WARM_INTERVAL_MS = 10_000

type Deps = {
  send: () => void
  now: () => number
  minIntervalMs?: number
}

export function createWarmTrigger(deps: Deps): () => void {
  const interval = deps.minIntervalMs ?? WARM_INTERVAL_MS
  let lastWarmedAt: number | null = null

  return () => {
    const now = deps.now()
    if (!shouldWarm(lastWarmedAt, now, interval)) return
    lastWarmedAt = now
    try {
      deps.send()
    } catch {
      // Warming is best-effort; a failure just means a colder first turn.
    }
  }
}

/**
 * The app-wide trigger. Call on intent signals — composer focus, typing, or
 * clicking a suggested question — never on a timer.
 */
export const warmOnIntent = createWarmTrigger({
  now: () => Date.now(),
  send: () => {
    void fetch('/api/warm', { method: 'POST', keepalive: true }).catch(() => {})
  }
})
