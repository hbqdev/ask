// Resilient node-redis clients for the app's LOCAL Redis (LOCAL_REDIS_URL).
//
// Why this exists (incident 2026-09-27): the weekly image update recreated the
// `redis` sidecar while the app kept running. Every module-level client built
// with a bare `createClient({ url }) + connect()` then broke PERMANENTLY:
//
//   1. With no 'error' listener, node-redis's "Socket closed unexpectedly"
//      re-emit throws (EventEmitter semantics) out of the socket's close
//      handler — logged as `uncaughtException` — BEFORE the client schedules
//      its reconnect. The client is left open-but-never-ready, forever.
//   2. The default offline queue then accepts every later command and holds it
//      until a reconnect that never comes. The advanced-search route's first
//      await is a cache GET, so it never sent response headers and every
//      balanced/quality first search hung until undici's 300s headers timeout.
//
// Clients built here cannot do that:
//   - an 'error' listener (logged once per state change, never thrown), so the
//     built-in reconnect actually runs;
//   - `disableOfflineQueue`, so a command issued while disconnected REJECTS
//     immediately (callers already treat a rejection as a miss / no-op / fail-
//     closed) instead of queueing forever;
//   - a bounded connect attempt + capped reconnect backoff;
//   - every command bounded by a timeout (a half-open socket answers nothing);
//   - a client that ends up closed, or keeps timing out, is dropped and rebuilt
//     on the next call instead of being cached forever.
//
// Upstash REST clients are NOT built here; callers keep their Upstash branches.
// The pub/sub clients in lib/streaming/resumable-stream-context.ts and the
// fire-and-forget latency log already register 'error' listeners and are left
// on their own clients (pub/sub needs the offline queue semantics it has).

import { createClient } from 'redis'

export type LocalRedisClient = ReturnType<typeof createClient>

/** One connect attempt (TCP + handshake) before node-redis retries. */
export const LOCAL_REDIS_CONNECT_TIMEOUT_MS = 2_000
/** Per-command bound. Local Redis answers in ~1ms; 1s is a dead socket. */
export const LOCAL_REDIS_COMMAND_TIMEOUT_MS = 1_000
/** Consecutive command timeouts after which the client is torn down. */
export const LOCAL_REDIS_TIMEOUTS_BEFORE_REBUILD = 3

export function localRedisUrl(): string {
  return process.env.LOCAL_REDIS_URL || 'redis://localhost:6379'
}

/** LOCAL_REDIS_COMMAND_TIMEOUT_MS overrides the per-command bound. */
export function localRedisCommandTimeoutMs(): number {
  const n = Number(process.env.LOCAL_REDIS_COMMAND_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : LOCAL_REDIS_COMMAND_TIMEOUT_MS
}

/** Capped linear backoff: 0, 200, 400 ... 2000ms, then every 2s. */
export function localRedisReconnectDelayMs(retries: number): number {
  return Math.min(Math.max(0, retries) * 200, 2_000)
}

export class RedisCommandTimeoutError extends Error {
  constructor(ms: number) {
    super(`redis command timed out after ${ms}ms`)
    this.name = 'RedisCommandTimeoutError'
  }
}

/**
 * Reject if `op` has not settled within `ms`. The late settlement of `op` is
 * still observed, so it can never surface as an unhandled rejection.
 */
export function withRedisTimeout<T>(
  op: Promise<T>,
  ms: number = LOCAL_REDIS_COMMAND_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RedisCommandTimeoutError(ms)), ms)
    op.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

type CreateClientFn = (
  options: NonNullable<Parameters<typeof createClient>[0]>
) => LocalRedisClient

/**
 * Build (but do not connect) a node-redis client with the resilient options
 * and a state-change-deduplicated error log. Exported for tests and for any
 * caller that manages its own lifecycle; most callers want
 * createLocalRedisConnector instead.
 */
export function createResilientRedisClient(
  label: string,
  url: string = localRedisUrl(),
  create: CreateClientFn = createClient as unknown as CreateClientFn
): LocalRedisClient {
  const client = create({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: LOCAL_REDIS_CONNECT_TIMEOUT_MS,
      reconnectStrategy: localRedisReconnectDelayMs
    }
  })

  // Log once per state change: the first error after a healthy period, and
  // again only when the error itself changes (e.g. "Socket closed
  // unexpectedly" -> ECONNREFUSED while the sidecar restarts -> ENOTFOUND).
  // The retry loop re-emits the same error every backoff tick; repeating it
  // would bury the log. Never rethrows — that is the whole point.
  let lastError: string | null = null
  client.on('error', (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message === lastError) return
    lastError = message
    console.warn(
      `[redis:${label}] ${message} — commands fail fast until it reconnects`
    )
  })
  client.on('ready', () => {
    if (lastError !== null) console.log(`[redis:${label}] reconnected`)
    lastError = null
  })
  return client
}

// Lifecycle methods must not be wrapped in the command timeout (connect has
// its own bound; quit/disconnect settle on their own).
const UNBOUNDED_METHODS = new Set<PropertyKey>([
  'connect',
  'disconnect',
  'quit',
  'QUIT'
])

/**
 * Proxy whose Promise-returning methods (every Redis command) are bounded by
 * `ms`. Everything else — getters such as isReady, event methods — passes
 * straight through to the real client, and methods run with the REAL client
 * as `this` (node-redis uses private fields that a Proxy receiver would
 * break). Not `instanceof` @upstash/redis, so callers' dialect branches keep
 * working unchanged.
 */
function boundCommands(
  client: LocalRedisClient,
  ms: number,
  onOutcome: (timedOut: boolean) => void
): LocalRedisClient {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function' || UNBOUNDED_METHODS.has(prop)) {
        return value
      }
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(
          target,
          args
        )
        if (!(result instanceof Promise)) return result
        return withRedisTimeout(result, ms).then(
          out => {
            onOutcome(false)
            return out
          },
          error => {
            onOutcome(error instanceof RedisCommandTimeoutError)
            throw error
          }
        )
      }
    }
  })
}

export type LocalRedisConnector = {
  /**
   * A READY client, or null while local Redis is unreachable. Never throws.
   * Only the first call for a fresh client waits (at most connectWaitMs) for
   * it to connect; afterwards a not-ready client returns null immediately, so
   * a Redis outage costs callers nothing but a miss.
   */
  get(): Promise<LocalRedisClient | null>
  /** Tear down and forget the current client (tests, manual recovery). */
  reset(): void
}

export type LocalRedisConnectorOptions = {
  url?: () => string
  create?: CreateClientFn
  /** First-connect wait. Defaults to one connect attempt plus slack. */
  connectWaitMs?: number
  commandTimeoutMs?: number
  timeoutsBeforeRebuild?: number
}

/**
 * Lazily-built, self-healing local Redis client for one module.
 *
 *   const localRedis = createLocalRedisConnector('advanced-search')
 *   const client = await localRedis.get() // null => treat Redis as unavailable
 *
 * The returned client's commands are bounded by commandTimeoutMs and reject
 * fast while disconnected, so every existing `try { await client.x() } catch`
 * already maps an outage to the caller's own miss / no-op / fail-closed path.
 */
export function createLocalRedisConnector(
  label: string,
  options: LocalRedisConnectorOptions = {}
): LocalRedisConnector {
  const url = options.url ?? localRedisUrl
  const connectWaitMs =
    options.connectWaitMs ?? LOCAL_REDIS_CONNECT_TIMEOUT_MS + 500
  const commandTimeoutMs =
    options.commandTimeoutMs ?? localRedisCommandTimeoutMs()
  const timeoutsBeforeRebuild =
    options.timeoutsBeforeRebuild ?? LOCAL_REDIS_TIMEOUTS_BEFORE_REBUILD

  let raw: LocalRedisClient | null = null
  let bounded: LocalRedisClient | null = null
  // Settles when the first connect finishes OR connectWaitMs elapses,
  // whichever is first; shared by every caller of this client generation.
  let initialWait: Promise<void> | null = null
  let consecutiveTimeouts = 0

  const drop = (reason: string) => {
    const old = raw
    raw = null
    bounded = null
    initialWait = null
    consecutiveTimeouts = 0
    if (!old) return
    console.warn(`[redis:${label}] dropping client (${reason}); will rebuild`)
    try {
      if (old.isOpen) old.disconnect().catch(() => {})
    } catch {
      // already closed
    }
  }

  const build = () => {
    const client = createResilientRedisClient(label, url(), options.create)
    raw = client
    bounded = boundCommands(client, commandTimeoutMs, timedOut => {
      if (raw !== client) return
      if (!timedOut) {
        consecutiveTimeouts = 0
        return
      }
      consecutiveTimeouts += 1
      // A socket that is "ready" but answers nothing (half-open after the
      // peer vanished) is not detected by node-redis for minutes. Rebuilding
      // after a few straight timeouts bounds that to a handful of misses.
      if (consecutiveTimeouts >= timeoutsBeforeRebuild) {
        drop(`${consecutiveTimeouts} consecutive command timeouts`)
      }
    })
    // With a reconnectStrategy function, connect() keeps retrying rather than
    // rejecting on network errors, so it may never settle while Redis is down.
    // Bound only the WAIT; the client keeps reconnecting in the background
    // and becomes usable the moment Redis is back.
    const connected = client.connect().then(
      () => undefined,
      (error: unknown) => {
        if (raw === client) {
          drop(
            `connect failed: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    )
    initialWait = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, connectWaitMs)
      connected.finally(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  return {
    async get() {
      try {
        // Closed = quit/disconnected/gave up: it will never come back.
        if (raw && !raw.isOpen) drop('client closed')
        if (!raw) build()
        if (initialWait) await initialWait
        return raw && raw.isReady ? bounded : null
      } catch (error) {
        console.warn(`[redis:${label}] unavailable:`, error)
        return null
      }
    },
    reset() {
      drop('reset')
    }
  }
}
