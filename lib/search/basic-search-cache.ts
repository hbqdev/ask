// Caching for basic-depth searches.
//
// Only the FIRST search of a turn goes through /api/advanced-search, which has
// its own Redis cache. The three expansion variants and every follow-up search
// tier down to basic depth and call the provider directly — on a 10-tool-call
// turn that is ~11 of 12 requests, so roughly 92% of engine load bypassed the
// cache. SearXNG fans each of those to bing + google cse, and DuckDuckGo has
// been answering with CAPTCHAs.
//
// This is quality-neutral by construction: identical queries return identical
// results, so nothing the model reads changes. It only stops us asking the
// engines the same thing twice — which expansion variants do constantly, since
// the classifier runs at temperature 0 and produces the same variants for the
// same question every time.

import { Redis } from '@upstash/redis'
import { createClient } from 'redis'

/** Matches the advanced cache so `--scan --pattern 'search:*'` clears both. */
export function basicSearchCacheKey(
  query: string,
  maxResults: number,
  timeRange?: string
): string {
  // `basic` namespaces this apart from the advanced cache: an advanced result
  // carries crawled and reranked content, a basic one does not, and serving
  // one for the other would silently change what the model reads.
  return `search:basic:${query}:${maxResults}:${timeRange ?? ''}`
}

export type CacheIO = {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string) => Promise<void>
}

/**
 * Serve `search` from cache when possible. Every failure path falls through to
 * the live search, so a Redis outage degrades to today's behaviour.
 */
export async function withBasicSearchCache<T extends { results?: unknown[] }>(
  key: string,
  search: () => Promise<T>,
  io: CacheIO
): Promise<T> {
  try {
    const cached = await io.get(key)
    if (cached) return JSON.parse(cached) as T
  } catch {
    // miss and continue
  }

  const fresh = await search()

  try {
    // Never cache an empty set: that is usually a transient engine failure,
    // and caching it would persist the failure for the whole TTL.
    if (Array.isArray(fresh?.results) && fresh.results.length > 0) {
      await io.set(key, JSON.stringify(fresh))
    }
  } catch {
    // results still returned
  }
  return fresh
}

const CACHE_TTL = 3600

let client: Redis | ReturnType<typeof createClient> | null | undefined

/** Same connection strategy as advanced-search/route.ts. */
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

/** Redis-backed CacheIO; a null client makes every call a silent no-op. */
export const redisCacheIO: CacheIO = {
  async get(key) {
    const c = await getClient()
    if (!c) return null
    // The two clients have incompatible get() signatures; branch like
    // advanced-search/route.ts does.
    if (c instanceof Redis) return (await c.get<string>(key)) ?? null
    return (await c.get(key)) as string | null
  },
  async set(key, value) {
    const c = await getClient()
    if (!c) return
    if (c instanceof Redis) await c.set(key, value, { ex: CACHE_TTL })
    else await c.set(key, value, { EX: CACHE_TTL })
  }
}
