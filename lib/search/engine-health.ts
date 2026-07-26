// Stops Ask asking SearXNG for engines that are currently refusing us.
//
// SearXNG reports which engines failed — `unresponsive_engines` in every JSON
// response — but keeps calling them anyway. Measured on the live instance:
// [['brave','too many requests'], ['startpage','CAPTCHA']] while both were
// still being queried on every search. Each attempt is pure latency AND burns
// IP reputation against a provider that is already blocking us, which is how
// the blocking started.
//
// SearXNG has no runtime API to enable or disable an engine — doing this
// server-side would mean rewriting settings.yml and restarting the container,
// far too heavy for a transient CAPTCHA. So the gate lives on the client:
// Ask already chooses which engines to request, so it can simply stop asking
// for the dead ones. No SearXNG change, no restart, and no health probing,
// because SearXNG already tells us on every response. The signal is free; we
// were discarding it.
//
// Design note: this module is pure. The Redis plumbing lives in
// engine-health-store.ts so the state machine can be tested without a server.

export interface EngineHealthState {
  /** Failures seen inside the current window. */
  breaches: number
  /** When the current window opened — breaches older than this are forgotten. */
  firstBreachAt: number
  /** Epoch ms until which the engine is suspended; 0 when healthy. */
  suspendedUntil: number
}

export interface EngineHealthOptions {
  threshold: number
  windowMs: number
  cooldownMs: number
}

/** One CAPTCHA is noise; three inside the window is a pattern. */
const DEFAULT_THRESHOLD = 3
const DEFAULT_WINDOW_MS = 600_000 // 10 min
const DEFAULT_COOLDOWN_MS = 1_800_000 // 30 min

export function engineHealthOptions(): EngineHealthOptions {
  const num = (raw: string | undefined, fallback: number) => {
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    threshold: num(process.env.ENGINE_BREACH_THRESHOLD, DEFAULT_THRESHOLD),
    windowMs:
      num(process.env.ENGINE_BREACH_WINDOW_S, DEFAULT_WINDOW_MS / 1000) * 1000,
    cooldownMs:
      num(process.env.ENGINE_COOLDOWN_S, DEFAULT_COOLDOWN_MS / 1000) * 1000
  }
}

/**
 * Opt-out, matching QUERY_EXPANSION_ENABLED: only the exact string 'false'
 * disables the gate. This changes which engines run, so it needs a real lever.
 */
export function engineHealthEnabled(): boolean {
  return process.env.ENGINE_HEALTH_ENABLED !== 'false'
}

/**
 * SearXNG returns unresponsive_engines as [name, reason] pairs, e.g.
 * [['brave','too many requests']]. Older builds emit a bare name list. Anything
 * else is ignored rather than thrown on — a parser that throws here would take
 * down search itself over a telemetry field.
 */
export function parseUnresponsiveEngines(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const names: string[] = []
  for (const entry of raw) {
    const name = Array.isArray(entry) ? entry[0] : entry
    if (typeof name === 'string' && name.trim()) names.push(name.trim())
  }
  return names
}

export function isEngineSuspended(
  state: EngineHealthState | undefined,
  now: number
): boolean {
  return !!state && state.suspendedUntil > now
}

export function recordSuccess(): EngineHealthState {
  return { breaches: 0, firstBreachAt: 0, suspendedUntil: 0 }
}

export function recordFailure(
  state: EngineHealthState | undefined,
  now: number,
  opts: EngineHealthOptions = engineHealthOptions()
): EngineHealthState {
  // A failure at or past suspendedUntil is the post-cooldown retry failing.
  // That retry IS the probe, so go straight back to suspended rather than
  // paying another `threshold` round trips to re-learn what we just saw.
  if (state && state.suspendedUntil > 0 && now >= state.suspendedUntil) {
    return {
      breaches: opts.threshold,
      firstBreachAt: now,
      suspendedUntil: now + opts.cooldownMs
    }
  }

  const windowExpired = !state || now - state.firstBreachAt > opts.windowMs
  const breaches = windowExpired ? 1 : state.breaches + 1
  const firstBreachAt = windowExpired ? now : state.firstBreachAt

  return {
    breaches,
    firstBreachAt,
    suspendedUntil:
      breaches >= opts.threshold
        ? now + opts.cooldownMs
        : (state?.suspendedUntil ?? 0)
  }
}

/**
 * Drop suspended engines from the list this search will request.
 *
 * The guard that matters: if EVERY requested engine is suspended, return the
 * original list untouched. A search against a blocked engine may still return
 * something; a search with an empty `engines` param returns nothing at all,
 * guaranteed. Degrading to "try anyway" is strictly better than degrading to
 * "no results" — and it is the invariant the old degoog watchdog had that must
 * survive the port.
 */
export function filterHealthyEngines(
  requested: string[],
  suspended: ReadonlySet<string>
): string[] {
  if (requested.length === 0) return []
  const healthy = requested.filter(e => !suspended.has(e))
  return healthy.length > 0 ? healthy : requested
}

/**
 * Build the `disabled_engines` parameter that actually excludes an engine.
 *
 * Dropping an engine from `engines` is NOT enough. Measured on the live
 * instance: SearXNG UNIONS `categories` with `engines`, so with
 * `categories=general` every enabled general engine runs regardless of the pin.
 * That is why brave, startpage and mojeek showed up in Ask's searches despite
 * never appearing in SEARXNG_ENGINES_ADVANCED — the pin never restricted
 * anything, it only ADDED to what the categories already selected.
 *
 * `disabled_engines` does exclude, using SearXNG's `name__category` form, but
 * an engine named explicitly in `engines` overrides it. So suspension requires
 * both: remove from `engines` AND list here, for every category in play.
 */
export function buildDisabledEnginesParam(
  suspended: ReadonlySet<string>,
  categories: string[]
): string {
  if (suspended.size === 0 || categories.length === 0) return ''
  const pairs: string[] = []
  for (const engine of suspended) {
    for (const category of categories) {
      pairs.push(`${engine}__${category}`)
    }
  }
  return pairs.join(',')
}
