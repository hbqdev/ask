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

// Engines we have ever seen fail. Needed because SearXNG unions `categories`
// with `engines`: brave, startpage and mojeek run on every Ask search despite
// appearing in NEITHER pinned list, so the pinned list alone is the wrong
// universe to check. Without this the engines costing us the most would never
// be looked up, and so never suspended.
const KNOWN_KEY = `${KEY_PREFIX}__known`

async function readKnownEngines(io: CacheIO): Promise<string[]> {
  try {
    const raw = await io.get(KNOWN_KEY)
    if (!raw) return []
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed)
      ? parsed.filter((e): e is string => typeof e === 'string')
      : []
  } catch {
    return []
  }
}

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

  // Check the pinned engines AND every engine we have seen fail before —
  // category-selected engines never appear in `requested` but do run.
  const universe = new Set([...requested, ...(await readKnownEngines(io))])

  const states = await Promise.all(
    [...universe].map(async e => [e, await readState(e, io)] as const)
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

  // Every engine SearXNG named is a breach, whether or not we pinned it. The
  // category union means the worst offenders (brave, startpage) are never in
  // `requested`, so scoping breaches to it would miss them entirely.
  if (unresponsive.length > 0) {
    try {
      const known = new Set(await readKnownEngines(io))
      const before = known.size
      for (const e of unresponsive) known.add(e)
      if (known.size !== before) {
        await io.set(KNOWN_KEY, JSON.stringify([...known]))
      }
    } catch {
      // Best-effort; a missed registration just delays suspension.
    }
  }

  await Promise.all(
    [...new Set([...requested, ...unresponsive])].map(async engine => {
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
