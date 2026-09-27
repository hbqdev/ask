// Time bound for the search tool's internal POST to /api/advanced-search.
//
// That call had NO timeout. On 2026-09-27 the route's Redis client wedged
// after a sidecar recreate, the route never sent response headers, and every
// balanced/quality first search sat silent until undici's 300s
// UND_ERR_HEADERS_TIMEOUT killed the turn. The Redis fix removes that cause;
// this bounds ANY future stall of the route so a turn degrades instead of
// hanging.
//
// Two limits, because the route has two very different phases:
//
//   headers  In stream mode (the default) the route returns its NDJSON
//            Response right after auth + the Redis cache lookup — normally
//            milliseconds — and streams preview/final lines afterwards. No
//            response headers within ADVANCED_SEARCH_HEADERS_TIMEOUT_MS
//            (default 20s) means the route is stuck before doing any search
//            work: exactly the 2026-09-27 failure. Not applied to the legacy
//            non-stream mode, whose headers only arrive with the final result.
//
//   total    Whole call including the streamed body. The default (180s) is
//            deliberately NOT tight: measured advanced searches (latency:log,
//            prod + lab) run to 69s and 91s on healthy quality/legacy turns
//            (crawl ~50s + legacy enrich ~20s), and the route's own internal
//            deadlines (SearXNG failover, 120s Crawl4AI chunk, 20s legacy
//            crawl, 20s cross-encoder) allow more than that. A 60s cap would
//            have cut real, successful quality searches. 180s still ends well
//            inside the 300s generation budget.
//
// The turn's own abort signal is combined in, so a user stop still cancels
// the call immediately and surfaces as a normal abort, not a timeout.

export const DEFAULT_ADVANCED_SEARCH_TIMEOUT_MS = 180_000
export const DEFAULT_ADVANCED_SEARCH_HEADERS_TIMEOUT_MS = 20_000

function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export function advancedSearchTimeoutMs(): number {
  return positiveIntEnv(
    'ADVANCED_SEARCH_TIMEOUT_MS',
    DEFAULT_ADVANCED_SEARCH_TIMEOUT_MS
  )
}

export function advancedSearchHeadersTimeoutMs(): number {
  return positiveIntEnv(
    'ADVANCED_SEARCH_HEADERS_TIMEOUT_MS',
    DEFAULT_ADVANCED_SEARCH_HEADERS_TIMEOUT_MS
  )
}

export type AdvancedSearchTimeoutPhase = 'headers' | 'total'

export class AdvancedSearchTimeoutError extends Error {
  readonly phase: AdvancedSearchTimeoutPhase
  readonly limitMs: number
  readonly elapsedMs: number

  constructor(
    phase: AdvancedSearchTimeoutPhase,
    limitMs: number,
    elapsedMs: number
  ) {
    super(
      phase === 'headers'
        ? `advanced-search sent no response headers within ${limitMs}ms`
        : `advanced-search did not finish within ${limitMs}ms`
    )
    this.name = 'AdvancedSearchTimeoutError'
    this.phase = phase
    this.limitMs = limitMs
    this.elapsedMs = elapsedMs
  }
}

export type AdvancedSearchDeadline = {
  /** Pass to fetch(); aborts on either timeout or on the turn's own abort. */
  signal: AbortSignal
  /** Call as soon as fetch() resolves (headers are in); stops the headers clock. */
  headersReceived(): void
  /**
   * The AdvancedSearchTimeoutError that fired, if the call was aborted by one
   * of these limits (and not by the turn's own signal). Check this in the
   * caller's catch: the rejection itself may be any AbortError shape.
   */
  timedOut(): AdvancedSearchTimeoutError | null
  /** Always call (finally): clears timers and the turn-signal listener. */
  clear(): void
}

export function createAdvancedSearchDeadline(opts: {
  turnSignal?: AbortSignal
  totalMs: number
  /** 0 / undefined disables the headers clock (non-stream mode). */
  headersMs?: number
}): AdvancedSearchDeadline {
  const controller = new AbortController()
  const startedAt = performance.now()
  let fired: AdvancedSearchTimeoutError | null = null

  const fire = (phase: AdvancedSearchTimeoutPhase, limitMs: number) => {
    if (controller.signal.aborted) return
    fired = new AdvancedSearchTimeoutError(
      phase,
      limitMs,
      Math.round(performance.now() - startedAt)
    )
    controller.abort(fired)
  }

  const totalTimer = setTimeout(() => fire('total', opts.totalMs), opts.totalMs)
  let headersTimer: ReturnType<typeof setTimeout> | undefined =
    opts.headersMs && opts.headersMs > 0
      ? setTimeout(() => fire('headers', opts.headersMs!), opts.headersMs)
      : undefined

  const turnSignal = opts.turnSignal
  const onTurnAbort = () => {
    if (!controller.signal.aborted) controller.abort(turnSignal?.reason)
  }
  if (turnSignal) {
    if (turnSignal.aborted) onTurnAbort()
    else turnSignal.addEventListener('abort', onTurnAbort, { once: true })
  }

  return {
    signal: controller.signal,
    headersReceived() {
      if (headersTimer) clearTimeout(headersTimer)
      headersTimer = undefined
    },
    timedOut: () => fired,
    clear() {
      clearTimeout(totalTimer)
      if (headersTimer) clearTimeout(headersTimer)
      turnSignal?.removeEventListener('abort', onTurnAbort)
    }
  }
}
