// Redis plumbing for the engine health gate. The state machine itself is pure
// and lives in engine-health.ts.
//
// State is shared rather than per-process: a module-level map would let every
// worker re-learn the same CAPTCHA independently, which is most of the cost we
// are trying to avoid.
//
// Every path here fails OPEN. If Redis is down, no health is recorded and every
// engine reads as healthy — exactly today's behaviour. The gate is an
// optimisation, not a correctness requirement, and must never be the reason a
// search returns nothing.

import { type CacheIO, redisCacheIO } from './basic-search-cache'
import {
  engineHealthEnabled,
  engineHealthOptions,
  type EngineHealthState,
  isEngineSuspended,
  recordFailure,
  recordSuccess
} from './engine-health'

// Deliberately NOT under `search:` — ops flush search results with
// `--scan --pattern 'search:*'`, and that should not silently reset the gate.
const KEY_PREFIX = 'enginehealth:'

const keyFor = (engine: string) => `${KEY_PREFIX}${engine}`

async function readState(
  engine: string,
  io: CacheIO
): Promise<EngineHealthState | undefined> {
  try {
    const raw = await io.get(keyFor(engine))
    if (!raw) return undefined
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (
      parsed &&
      typeof parsed.breaches === 'number' &&
      typeof parsed.suspendedUntil === 'number'
    ) {
      return parsed as EngineHealthState
    }
  } catch {
    // Unreadable or unparseable — treat as healthy.
  }
  return undefined
}

/**
 * Which of `requested` are currently suspended. Returns an empty set when the
 * gate is disabled or Redis is unreachable.
 */
export async function loadSuspendedEngines(
  requested: string[],
  io: CacheIO = redisCacheIO,
  now: number = Date.now()
): Promise<Set<string>> {
  const suspended = new Set<string>()
  if (!engineHealthEnabled() || requested.length === 0) return suspended

  const states = await Promise.all(
    requested.map(async e => [e, await readState(e, io)] as const)
  )
  for (const [engine, state] of states) {
    if (isEngineSuspended(state, now)) suspended.add(engine)
  }
  return suspended
}

/**
 * Fold one search's outcome into engine health: engines SearXNG named as
 * unresponsive take a breach, the rest of the engines we actually asked for
 * are credited with a success.
 *
 * Only engines in `requested` are credited — an engine we did not ask for
 * cannot have succeeded, and crediting it would clear a suspension that no
 * search ever tested.
 */
export async function recordEngineOutcomes(
  {
    requested,
    unresponsive
  }: {
    requested: string[]
    unresponsive: string[]
  },
  io: CacheIO = redisCacheIO,
  now: number = Date.now()
): Promise<void> {
  if (!engineHealthEnabled() || requested.length === 0) return

  const opts = engineHealthOptions()
  const failed = new Set(unresponsive)

  await Promise.all(
    requested.map(async engine => {
      try {
        if (failed.has(engine)) {
          const next = recordFailure(await readState(engine, io), now, opts)
          await io.set(keyFor(engine), JSON.stringify(next))
          return
        }
        // Only write on a state change — a healthy engine that is already
        // recorded healthy does not need a Redis round trip per search.
        const current = await readState(engine, io)
        if (current && current.breaches > 0) {
          await io.set(keyFor(engine), JSON.stringify(recordSuccess()))
        }
      } catch {
        // Health is best-effort; never let it surface into the search path.
      }
    })
  )
}
