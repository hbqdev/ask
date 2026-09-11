// Liveness signal for the external ingestion worker (the separate `ingestor`
// service — NOT in this repo, no health endpoint we can scrape). The worker
// polls /api/ingest/claim continuously (every POLL_INTERVAL, 15s default, even
// when idle) and reports /api/ingest/progress several times per job, so any
// authenticated hit on those token-gated routes proves it is alive and
// consuming. Those routes call recordIngestHeartbeat() to refresh a
// short-lived Redis key; the answer path reads isIngestorAlive() to tell a
// genuinely-down worker apart from a merely-slow one when an upload is still
// unclaimed (see lib/streaming/helpers/transform-file-parts.ts). The key is
// also directly operator-observable: `redis-cli TTL ingest:heartbeat`.
//
// Redis-optional by construction: recording is best-effort (a Redis blip must
// never break the claim/progress response), and isIngestorAlive() returns null
// (= unknown) when Redis can't be read, so we never falsely accuse a live
// worker of being down on a cache outage.

import { Redis } from '@upstash/redis'
import { createClient } from 'redis'

const HEARTBEAT_KEY = 'ingest:heartbeat'

// The worker refreshes the key well inside this window in every state (idle
// poll every ~15s, several progress reports per job), so default 60s = ~4
// missed idle polls before we call it down. Env-tunable; <= 0 disables the
// heartbeat entirely — recording and reading both no-op, and isIngestorAlive()
// stays null, so the "temporarily unavailable" message never fires.
function heartbeatTtlSeconds(): number {
  const n = Number(process.env.INGEST_HEARTBEAT_TTL_S ?? 60)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

let client: Redis | ReturnType<typeof createClient> | null | undefined

// Same connection strategy as lib/search/basic-search-cache.ts (Upstash REST
// when configured, otherwise a local redis:// connection); a null client makes
// every call a silent no-op.
async function getClient() {
  if (client !== undefined) return client
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (url && token) {
    client = new Redis({ url, token })
    return client
  }
  try {
    const local = createClient({
      url: process.env.LOCAL_REDIS_URL || 'redis://localhost:6379'
    })
    await local.connect()
    client = local
  } catch {
    client = null
  }
  return client
}

// Refresh the worker-alive key with a fresh TTL. Best-effort: called from the
// hot claim/progress request path, so every failure is swallowed and can never
// affect the worker's response. The value is a timestamp purely so an operator
// inspecting the key sees a last-seen time; liveness itself is the TTL.
export async function recordIngestHeartbeat(): Promise<void> {
  const ttl = heartbeatTtlSeconds()
  if (ttl <= 0) return
  try {
    const c = await getClient()
    if (!c) return
    const value = String(Date.now())
    // The two clients take incompatible option casing; branch like
    // basic-search-cache.ts does.
    if (c instanceof Redis) await c.set(HEARTBEAT_KEY, value, { ex: ttl })
    else await c.set(HEARTBEAT_KEY, value, { EX: ttl })
  } catch {
    // A heartbeat write must never fail the claim/progress response.
  }
}

// true  = a worker refreshed the key within the TTL (alive and consuming)
// false = the key expired or was never set (worker down / not polling)
// null  = unknown (heartbeat disabled, or Redis unreadable) — callers must NOT
//         treat this as "down".
export async function isIngestorAlive(): Promise<boolean | null> {
  if (heartbeatTtlSeconds() <= 0) return null
  try {
    const c = await getClient()
    if (!c) return null
    const raw =
      c instanceof Redis
        ? await c.get<string>(HEARTBEAT_KEY)
        : ((await c.get(HEARTBEAT_KEY)) as string | null)
    return Boolean(raw)
  } catch {
    return null
  }
}
