import { NextResponse } from 'next/server'

import { fetchQuotesFromCouchbase } from '@/lib/quotes/couchbase-quotes'
import { FALLBACK_QUOTES } from '@/lib/quotes/fallback-quotes'
import { normalizePool } from '@/lib/quotes/quote-pool'
import type { Quote } from '@/lib/quotes/types'
import { getLatencyRedis } from '@/lib/telemetry/latency-store'

// The middle server for quotes: Couchbase credentials live here and never
// reach the browser. The client fetches ONE batch per page session and cycles
// it locally, so no request is made while the user is actually waiting.
//
// Degradation order is Redis cache → Couchbase (then populate the cache) →
// bundled set. A quote is decoration: every branch below returns 200 with a
// usable batch, and nothing in here is allowed to throw.

const CACHE_KEY = 'quotes:pool'
const CACHE_TTL_SECONDS = 60 * 60 * 24
const DEFAULT_BATCH = 40
const MAX_BATCH = 100

// getLatencyRedis() is typed for the list operations telemetry uses. Both
// dialects behind it (node-redis, Upstash) also expose get/set, but the type
// does not promise it, hence the runtime guards below.
type CacheClient = {
  get?: (key: string) => Promise<unknown>
  set?: (key: string, value: string, opts?: unknown) => Promise<unknown>
}

async function readCache(client: CacheClient): Promise<Quote[] | null> {
  if (typeof client.get !== 'function') return null
  const raw = await client.get(CACHE_KEY)
  if (typeof raw !== 'string' || !raw) return null

  // JSON.parse throws on a truncated or half-written value; loadPool's catch
  // turns that into a Couchbase fetch, which then overwrites the bad entry.
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) return null

  // The cache is not a trusted input — anything with the Redis credentials can
  // write that key, and an older format could still be sitting there under the
  // 24h TTL. Re-run the same validation the write path used rather than
  // forwarding whatever was stored straight to the client.
  const pool = normalizePool(parsed)
  return pool.length ? pool : null
}

async function writeCache(client: CacheClient, pool: Quote[]): Promise<void> {
  if (typeof client.set !== 'function') return
  const payload = JSON.stringify(pool)
  // node-redis takes { EX }, Upstash takes { ex }; send both, each ignores the other.
  await client.set(CACHE_KEY, payload, {
    EX: CACHE_TTL_SECONDS,
    ex: CACHE_TTL_SECONDS
  })
}

/** Resolve the pool through the degradation chain: Redis → Couchbase → bundled. */
async function loadPool(): Promise<Quote[]> {
  let client: CacheClient | null = null
  try {
    client = (await getLatencyRedis()) as CacheClient | null
    if (client) {
      const cached = await readCache(client)
      if (cached) return cached
    }
  } catch (error) {
    console.warn('[quotes] cache read failed:', error)
  }

  const fresh = normalizePool(await fetchQuotesFromCouchbase())
  // Deliberately not cached: pinning the bundled set for 24h would outlast the
  // Couchbase outage that caused it.
  if (!fresh.length) return FALLBACK_QUOTES

  try {
    if (client) await writeCache(client, fresh)
  } catch (error) {
    console.warn('[quotes] cache write failed:', error)
  }
  return fresh
}

/** `?n=` clamped to [1, MAX_BATCH]; anything unparseable falls back to the default. */
function requestedBatchSize(request: Request): number {
  const requested = Number(new URL(request.url).searchParams.get('n'))
  if (!Number.isFinite(requested) || requested < 1) return DEFAULT_BATCH
  return Math.min(Math.floor(requested), MAX_BATCH)
}

/**
 * A contiguous window from a random offset, wrapping past the end. The pool is
 * already shuffled, so a rotation is enough to vary what a session sees, and
 * capping the window at the pool size keeps a short pool from repeating
 * itself inside one batch.
 */
function pickBatch(pool: Quote[], n: number): Quote[] {
  if (!pool.length) return []
  const start = Math.floor(Math.random() * pool.length)
  return Array.from(
    { length: Math.min(n, pool.length) },
    (_, i) => pool[(start + i) % pool.length]
  )
}

export async function GET(request: Request): Promise<NextResponse> {
  let pool = FALLBACK_QUOTES
  try {
    pool = await loadPool()
  } catch (error) {
    // The quote is decoration; a failure must degrade, never surface.
    console.warn('[quotes] falling back to bundled set:', error)
  }

  let n = DEFAULT_BATCH
  try {
    n = requestedBatchSize(request)
  } catch {
    // A URL we cannot parse is still a request for a default batch.
  }

  return NextResponse.json({ quotes: pickBatch(pool, n) })
}
