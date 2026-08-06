import { after, NextResponse } from 'next/server'

import { Redis } from '@upstash/redis'
import http from 'http'
import { Agent } from 'http'
import https from 'https'
import { JSDOM, VirtualConsole } from 'jsdom'
import { createClient } from 'redis'

import type { RankedPassage } from '@/lib/embeddings/rerank'
import {
  rerankByCrossEncoder,
  rerankByEmbedding
} from '@/lib/embeddings/rerank'
import { buildExcerptContent } from '@/lib/search/build-excerpt'
import { measureCropPositions } from '@/lib/search/crop-position'
import { isQualityContent } from '@/lib/search/quality-content'
import { runSnippetGate } from '@/lib/search/snippet-gate'
import { buildSearchTelemetryTag } from '@/lib/telemetry/search-tag'
import { StageTimer } from '@/lib/telemetry/stage-timer'
import { SEARXNG_ENGINES_ADVANCED } from '@/lib/tools/search/engines'
import { intentToCategory, type SearchIntent } from '@/lib/tools/search/intent'
import { mergeBraveIntoSearxngResults } from '@/lib/tools/search/providers/merge-brave'
import {
  mergeDegoogIntoSearxngResults,
  resolveDegoogUrl
} from '@/lib/tools/search/providers/merge-degoog'
import { mergeLangSearchIntoSearxngResults } from '@/lib/tools/search/providers/merge-langsearch'
import { mergeOllamaIntoSearxngResults } from '@/lib/tools/search/providers/merge-ollama'
import { mergeTavilyIntoSearxngResults } from '@/lib/tools/search/providers/merge-tavily'
import {
  DegoogResponse,
  SearchResultItem,
  SearXNGResponse,
  SearXNGResult,
  SearXNGSearchResults
} from '@/lib/types'
import {
  type BraveSearchResult,
  fetchBraveSearch
} from '@/lib/utils/brave-search-client'
import { crawl4aiScrapeMany, isCrawl4aiConfigured } from '@/lib/utils/crawl4ai'
import { isCrossEncoderConfigured } from '@/lib/utils/cross-encoder'
import { fetchDegoogJson } from '@/lib/utils/degoog-client'
import {
  extractReadableContent,
  MIN_CONTENT_LENGTH
} from '@/lib/utils/extract-content'
import { checkIngestAuth } from '@/lib/utils/ingest-auth'
import {
  fetchLangSearch,
  isLangSearchConfigured,
  type LangSearchResult
} from '@/lib/utils/langsearch-client'
import {
  fetchOllamaSearch,
  type OllamaSearchResult
} from '@/lib/utils/ollama-search-client'
import {
  isParseableContentType,
  MAX_PARSEABLE_BYTES
} from '@/lib/utils/parseable-content'
import { fetchSearxngJson } from '@/lib/utils/searxng-client'
import {
  fetchTavilySearch,
  type TavilySearchResult
} from '@/lib/utils/tavily-search-client'
import { withDeadline } from '@/lib/utils/with-deadline'

import { buildReturnedRanks } from './returned-ranks'

/**
 * Maximum number of results to fetch from SearXNG.
 * Increasing this value can improve result quality but may impact performance.
 * In advanced search mode, this is multiplied by SEARXNG_CRAWL_MULTIPLIER for initial fetching.
 */
const SEARXNG_MAX_RESULTS = Math.max(
  10,
  Math.min(100, parseInt(process.env.SEARXNG_MAX_RESULTS || '50', 10))
)

/**
 * Wall-clock safety net for a single legacy crawl, so one pathological page
 * cannot hang the stage indefinitely. Set at 20s to MATCH crawlPage's own
 * fetch timeout: it is a backstop for the JSDOM phase (which has no timeout of
 * its own), NOT a page-dropper. A tighter 6s value was tried and timed out 9
 * pages that would otherwise have succeeded, costing sources for no reliable
 * latency gain.
 */
const LEGACY_CRAWL_BUDGET_MS = Math.max(
  1000,
  parseInt(process.env.LEGACY_CRAWL_BUDGET_MS || '20000', 10)
)

/**
 * Hard cap on how many candidates take the legacy path.
 *
 * DEFAULTS TO EFFECTIVELY UNLIMITED, deliberately. A controlled A/B on the
 * same query showed a cap of 8 cut returned sources 15 -> 6 (rerank pool
 * 42 -> 14), dropping nvidia.com, Tom's Hardware, PCWorld and PC Gamer —
 * WITHOUT reliably saving time (enrich_ms was still 29.8s at cap=8, because a
 * single JSDOM parse can cost ~3.7s). Capping page count trades sources for
 * nothing. Raise this only with a fresh A/B on returned URLs; result COUNTS
 * are not a quality signal — that mistake is what shipped the regression.
 *
 * The real cost difference is process isolation, not page count: crawlPage
 * parses with JSDOM (`resources: 'usable'`) ON the Node event loop, so it
 * serialises and stalls every other request this server handles. Crawl4AI is
 * a sidecar container on this same host with its own process pool, so it uses
 * the box's other cores instead. Prefer moving pages to it (MAX_ENRICH_URLS)
 * over refusing to enrich them.
 *
 * Pages past the cap keep their search snippet, which usually fails
 * isQualityContent (>50 words) and is therefore dropped, not merely thinned.
 */
const MAX_LEGACY_CRAWL_URLS = Math.max(
  0,
  parseInt(process.env.MAX_LEGACY_CRAWL_URLS || '999', 10)
)

/**
 * Fetch Google Images via degoog alongside every search. Default OFF: SearXNG
 * already returns images in the same round-trip, so this only adds variety at
 * the cost of a SECOND degoog request per search — and each degoog request fans
 * out to Google, Brave, Startpage and DDG internally, against a per-IP quota
 * shared with SearXNG and ordinary browsing.
 */
const DEGOOG_IMAGES_ENABLED = process.env.DEGOOG_IMAGES_ENABLED === 'true'

/**
 * Per-chunk budget for the Crawl4AI sidecar.
 *
 * Raised from 60s after a measured regression: with concurrency at 6, chunks
 * queue behind each other, and 5 of 10 chunks blew a 60s budget on one turn.
 * An aborted chunk discards ALL 8 of its rendered pages and the caller then
 * re-crawls them on the slow legacy path -- 43 of 75 URLs fell back that way,
 * which is both slower and worse content than simply waiting. The sidecar
 * already bounds individual pages internally (Page.goto times out at 12s), so
 * a generous budget here costs nothing on healthy chunks and only stops us
 * throwing away work that was nearly done.
 */
const CRAWL4AI_CHUNK_TIMEOUT_MS = Math.max(
  30_000,
  parseInt(process.env.CRAWL4AI_CHUNK_TIMEOUT_MS || '120000', 10)
)

/**
 * degoog: ON by default, set DEGOOG_ENABLED=false to kill it.
 *
 * It was OFF from 2026-07-25 because it scraped Google, Brave, Startpage and
 * DDG from our residential IP — every one of those was refusing it (Google 403,
 * Brave 429, Startpage + DDG CAPTCHA), so it contributed almost nothing while
 * spending the per-IP reputation SearXNG and ordinary browsing depend on. ~25
 * test searches took Brave down for SearXNG too.
 *
 * That coupling is gone: degoog egresses its own Mullvad tunnel
 * (us-atl-wg-406) and Ask's SearXNG uses us-was-wg-001/002, so neither can
 * spend the other's quota, and neither touches the residential IP.
 *
 * Kept because it is not redundant. 7 of its enabled engines — reddit, hacker
 * news, lemmy, internet archive, wikimedia commons, nasa images, openverse —
 * are sources SearXNG is never asked for, and merge-degoog.ts promotes exactly
 * those ahead of mainstream results so they survive truncation. The
 * overlapping ~60% dedupes away by normalized URL.
 *
 * The real gate now lives in fetchDegoogJson so this flag reaches the basic
 * provider's fan-out too; this const only avoids building requests we would
 * discard. Both must agree — hence the shared `!== 'false'` default.
 */
const DEGOOG_ENABLED = process.env.DEGOOG_ENABLED !== 'false'

const CACHE_TTL = 3600 // Cache time-to-live in seconds (1 hour)
const CACHE_EXPIRATION_CHECK_INTERVAL = 3600000 // 1 hour in milliseconds

let redisClient: Redis | ReturnType<typeof createClient> | null = null

// Initialize Redis client based on environment variables
async function initializeRedisClient() {
  if (redisClient) return redisClient

  const upstashRedisRestUrl = process.env.UPSTASH_REDIS_REST_URL
  const upstashRedisRestToken = process.env.UPSTASH_REDIS_REST_TOKEN

  // Use Upstash Redis if credentials are provided
  if (upstashRedisRestUrl && upstashRedisRestToken) {
    redisClient = new Redis({
      url: upstashRedisRestUrl,
      token: upstashRedisRestToken
    })
    return redisClient
  }

  // Otherwise, try to use local Redis (for Docker/SearXNG usage)
  try {
    const localRedisUrl =
      process.env.LOCAL_REDIS_URL || 'redis://localhost:6379'
    const client = createClient({ url: localRedisUrl })
    await client.connect()
    redisClient = client
  } catch (error) {
    console.warn(
      'Failed to connect to local Redis. Advanced search caching disabled.',
      error
    )
    redisClient = null
  }

  return redisClient
}

// Function to get cached results
async function getCachedResults(
  cacheKey: string
): Promise<SearXNGSearchResults | null> {
  try {
    const client = await initializeRedisClient()
    if (!client) return null

    let cachedData: string | null
    if (client instanceof Redis) {
      cachedData = await client.get(cacheKey)
    } else {
      cachedData = await client.get(cacheKey)
    }

    if (cachedData) {
      console.log(`Cache hit for key: ${cacheKey}`)
      return JSON.parse(cachedData)
    } else {
      console.log(`Cache miss for key: ${cacheKey}`)
      return null
    }
  } catch (error) {
    console.error('Redis cache error:', error)
    return null
  }
}

// Function to set cached results with error handling and logging
async function setCachedResults(
  cacheKey: string,
  results: SearXNGSearchResults
): Promise<void> {
  try {
    const client = await initializeRedisClient()
    if (!client) return

    const serializedResults = JSON.stringify(results)
    if (client instanceof Redis) {
      await client.set(cacheKey, serializedResults, { ex: CACHE_TTL })
    } else {
      await client.set(cacheKey, serializedResults, { EX: CACHE_TTL })
    }
    console.log(`Cached results for key: ${cacheKey}`)
  } catch (error) {
    console.error('Redis cache error:', error)
  }
}

// Function to periodically clean up expired cache entries
async function cleanupExpiredCache() {
  try {
    const client = await initializeRedisClient()
    if (!client) return

    const keys = await client.keys('search:*')
    for (const key of keys) {
      const ttl = await client.ttl(key)
      if (ttl <= 0) {
        await client.del(key)
        console.log(`Removed expired cache entry: ${key}`)
      }
    }
  } catch (error) {
    console.error('Cache cleanup error:', error)
  }
}

// Set up periodic cache cleanup
setInterval(cleanupExpiredCache, CACHE_EXPIRATION_CHECK_INTERVAL)

// --- Tavily merge budget ---------------------------------------------------
// Tavily is a metered, block-immune source folded into the advanced path
// (balanced/quality modes). Unlike Ollama/degoog it costs credits (free tier
// ~1000 searches/mo), so gate it behind a monthly budget tracked in the same
// Redis. When the budget is spent the advanced search silently falls back to
// searxng+degoog+ollama — no error, just fewer sources.
const TAVILY_MONTHLY_BUDGET = Math.max(
  0,
  parseInt(process.env.TAVILY_MONTHLY_BUDGET || '1000', 10)
)
const TAVILY_MERGE_MAX_RESULTS = Math.max(
  1,
  parseInt(process.env.TAVILY_MERGE_MAX_RESULTS || '5', 10)
)

function isTavilyMergeEnabled(): boolean {
  return (
    Boolean(process.env.TAVILY_API_KEY) &&
    process.env.TAVILY_MERGE_ENABLED !== 'off' &&
    TAVILY_MONTHLY_BUDGET > 0
  )
}

function currentTavilyBudgetKey(): string {
  const d = new Date()
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  return `tavily:budget:${month}`
}

/**
 * Fetch Tavily for this advanced search IF enabled and under the monthly
 * budget. The counter is incremented only on a SUCCESSFUL Tavily call (a Tavily
 * outage must not burn the month's quota), so this reads the count, fetches,
 * then increments. The read→incr race is harmless for a soft budget with 1h
 * result caching. Never throws for budget/Redis reasons (returns null); a real
 * Tavily fetch error propagates so the caller's allSettled logs it and
 * continues without Tavily. Fails CLOSED (skips Tavily) when Redis is
 * unavailable so a cache outage can't blow the free-tier quota.
 */
// --- Brave API merge budget -----------------------------------------------
// The Brave Search API is the only general engine we have that CANNOT be
// blocked by our IP's reputation: the query runs on Brave's own infrastructure
// against a subscribed quota. Google 403s us, DuckDuckGo and Startpage serve
// CAPTCHAs, and SCRAPED Brave returns 429 — none of which touches this path.
// Metered (free tier ~2,000/mo), so budget-gate it like Tavily.
const BRAVE_MONTHLY_BUDGET = Math.max(
  0,
  parseInt(process.env.BRAVE_MONTHLY_BUDGET || '2000', 10)
)
const BRAVE_MERGE_MAX_RESULTS = Math.max(
  1,
  parseInt(process.env.BRAVE_MERGE_MAX_RESULTS || '10', 10)
)

function isBraveMergeEnabled(): boolean {
  return (
    Boolean(process.env.BRAVE_SEARCH_API_KEY) &&
    process.env.BRAVE_MERGE_ENABLED !== 'off' &&
    BRAVE_MONTHLY_BUDGET > 0
  )
}

function currentBraveBudgetKey(): string {
  const d = new Date()
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  return `brave:budget:${month}`
}

/**
 * Fetch Brave for this advanced search IF enabled and under the monthly budget.
 * Same contract as maybeFetchTavily: counts only SUCCESSFUL calls (an outage
 * must not burn the quota), never throws for budget/Redis reasons, and fails
 * CLOSED when Redis is unavailable so a cache outage cannot blow the free tier.
 */
async function maybeFetchBrave(
  query: string
): Promise<BraveSearchResult[] | null> {
  if (!isBraveMergeEnabled()) return null
  const rawClient = await initializeRedisClient()
  if (!rawClient) return null
  const client = rawClient as unknown as {
    get(key: string): Promise<unknown>
    incr(key: string): Promise<number>
    expire(key: string, seconds: number): Promise<unknown>
  }

  const key = currentBraveBudgetKey()
  let spent = 0
  try {
    spent = Number(await client.get(key)) || 0
  } catch (error) {
    console.warn('[brave] budget read failed, skipping Brave:', error)
    return null
  }
  if (spent >= BRAVE_MONTHLY_BUDGET) return null

  const results = await fetchBraveSearch(query, BRAVE_MERGE_MAX_RESULTS)

  try {
    const n = await client.incr(key)
    if (n === 1) await client.expire(key, 60 * 60 * 24 * 35)
  } catch (error) {
    console.warn('[brave] budget increment failed:', error)
  }
  return results
}

async function maybeFetchTavily(
  query: string
): Promise<TavilySearchResult[] | null> {
  if (!isTavilyMergeEnabled()) return null
  const rawClient = await initializeRedisClient()
  if (!rawClient) return null
  const client = rawClient as unknown as {
    get(key: string): Promise<unknown>
    incr(key: string): Promise<number>
    expire(key: string, seconds: number): Promise<unknown>
  }

  const key = currentTavilyBudgetKey()
  let spent = 0
  try {
    spent = Number(await client.get(key)) || 0
  } catch (error) {
    console.warn('[tavily] budget read failed, skipping Tavily:', error)
    return null
  }
  if (spent >= TAVILY_MONTHLY_BUDGET) return null

  const results = await fetchTavilySearch(query, TAVILY_MERGE_MAX_RESULTS)

  try {
    const n = await client.incr(key)
    // Expire ~35 days out so the counter resets each calendar month.
    if (n === 1) await client.expire(key, 60 * 60 * 24 * 35)
  } catch (error) {
    console.warn('[tavily] budget increment failed:', error)
  }
  return results
}

// --- LangSearch merge budget ------------------------------------------------
// Another block-immune general source, but metered DAILY rather than monthly:
// the free tier is 1 QPS / 1000 requests per day. The daily limit is why this
// budget key is per-day and why LangSearch is advanced-path only — the basic
// path fans several searches out at once per turn and would trip 1 QPS on its
// own.
const LANGSEARCH_DAILY_BUDGET = Math.max(
  0,
  parseInt(process.env.LANGSEARCH_DAILY_BUDGET || '900', 10) || 0
)
const LANGSEARCH_MERGE_MAX_RESULTS = Math.max(
  1,
  parseInt(process.env.LANGSEARCH_MERGE_MAX_RESULTS || '10', 10)
)

function isLangSearchMergeEnabled(): boolean {
  return (
    isLangSearchConfigured() &&
    process.env.LANGSEARCH_MERGE_ENABLED !== 'off' &&
    LANGSEARCH_DAILY_BUDGET > 0
  )
}

function currentLangSearchBudgetKey(): string {
  // Per DAY, not per month — the provider's quota is daily.
  return `langsearch:budget:${new Date().toISOString().slice(0, 10)}`
}

/**
 * Fetch LangSearch for this advanced search IF enabled and under today's
 * budget. Same contract as maybeFetchTavily: counts only SUCCESSFUL calls,
 * never throws for budget/Redis reasons, and fails CLOSED when Redis is
 * unavailable so a cache outage cannot blow the daily quota.
 *
 * Default budget is 900 rather than the documented 1000: exceeding the quota
 * is worse than under-using it, and the counter only sees calls this instance
 * made — prod and staging share one API key.
 */
async function maybeFetchLangSearch(
  query: string,
  timeRange?: 'day' | 'week' | 'month' | 'year'
): Promise<LangSearchResult[] | null> {
  if (!isLangSearchMergeEnabled()) return null
  const rawClient = await initializeRedisClient()
  if (!rawClient) return null
  const client = rawClient as unknown as {
    get(key: string): Promise<unknown>
    incr(key: string): Promise<number>
    expire(key: string, seconds: number): Promise<unknown>
  }

  const key = currentLangSearchBudgetKey()
  let spent = 0
  try {
    spent = Number(await client.get(key)) || 0
  } catch (error) {
    console.warn('[langsearch] budget read failed, skipping:', error)
    return null
  }
  if (spent >= LANGSEARCH_DAILY_BUDGET) return null

  const results = await fetchLangSearch(query, LANGSEARCH_MERGE_MAX_RESULTS, {
    timeRange
  })

  try {
    const n = await client.incr(key)
    // ~2 days so the per-day counter self-clears without piling up keys.
    if (n === 1) await client.expire(key, 60 * 60 * 48)
  } catch (error) {
    console.warn('[langsearch] budget increment failed:', error)
  }
  return results
}

/**
 * Include/exclude domain filtering, shared by the pre-merge and post-merge
 * passes. Substring match on hostname, matching the original inline behaviour.
 * A malformed URL is dropped rather than throwing — `new URL` on a bad href
 * previously took the whole request down.
 */
function applyDomainFilter<T extends { url: string }>(
  results: T[],
  includeDomains: string[],
  excludeDomains: string[]
): T[] {
  if (includeDomains.length === 0 && excludeDomains.length === 0) return results
  return results.filter(result => {
    let domain: string
    try {
      domain = new URL(result.url).hostname
    } catch {
      return false
    }
    return (
      (includeDomains.length === 0 ||
        includeDomains.some(d => domain.includes(d))) &&
      (excludeDomains.length === 0 ||
        !excludeDomains.some(d => domain.includes(d)))
    )
  })
}

export async function POST(request: Request) {
  // Internal-service endpoint. The ONLY caller is lib/tools/search.ts, server-
  // to-server, inside a chat turn that is already authenticated and rate-limited
  // at /api/chat. Before this it was reachable UNAUTHENTICATED over the public
  // tunnel, so anyone on the internet could drive SearXNG crawls and the metered
  // Tavily/Brave/LangSearch merges — draining paid quotas and compute. It now
  // requires the shared internal-service bearer token (same one the ingest
  // routes use); an external caller cannot forge it.
  const auth = checkIngestAuth(request.headers.get('authorization'))
  if (!auth.ok) {
    return new NextResponse(null, { status: auth.status })
  }

  const {
    query,
    maxResults,
    searchDepth,
    includeDomains,
    excludeDomains,
    timeRange,
    intent,
    useOllama,
    ollamaMaxResults,
    chatId,
    stream: wantsStream
  } = await request.json()

  const SEARXNG_DEFAULT_DEPTH = process.env.SEARXNG_DEFAULT_DEPTH || 'basic'
  const VALID_TIME_RANGES = ['day', 'week', 'month', 'year']
  const effectiveTimeRange = VALID_TIME_RANGES.includes(timeRange)
    ? (timeRange as string)
    : undefined

  try {
    const cacheKey = `search:${query}:${maxResults}:${searchDepth}:${
      Array.isArray(includeDomains) ? includeDomains.join(',') : ''
    }:${Array.isArray(excludeDomains) ? excludeDomains.join(',') : ''}:${
      effectiveTimeRange ?? ''
    }:${typeof intent === 'string' ? intent : ''}:${useOllama ? `oll${typeof ollamaMaxResults === 'number' ? ollamaMaxResults : 5}` : ''}`

    // Per-search stage timings. This is the half of the turn the [latency]
    // line cannot see: it is emitted from the chat pipeline, while the search
    // fan-out, crawl and rerank all happen behind this route.
    const timer = new StageTimer('latency:search', {
      // chatId joins this search to the turn that caused it. Turns make
      // multiple searches, so ordering alone mismatches rows.
      ...buildSearchTelemetryTag({ chatId }),
      depth: searchDepth || SEARXNG_DEFAULT_DEPTH,
      intent: typeof intent === 'string' ? intent : 'general'
    })

    // Try to get cached results
    const cachedResults = await timer.time('cache_ms', () =>
      getCachedResults(cacheKey)
    )
    if (cachedResults) {
      timer.set('cache', 'hit')
      timer.emit()
      // A streaming caller parses NDJSON and only accepts lines tagged
      // 'preview' or 'final' (lib/tools/search.ts). Returning a bare
      // NextResponse.json here — which this branch did for every cache hit,
      // because it runs BEFORE the `if (wantsStream)` block below — produced an
      // object with no `type`, so the caller matched neither branch, left
      // finalResult undefined and threw "Advanced search stream ended with no
      // final line". Every warm cache hit turned a free instant result into a
      // hard tool failure. Stream mode is the default
      // (SEARCH_STREAM_PREVIEW !== 'false'), so this was the normal path.
      if (wantsStream) {
        return new Response(
          `${JSON.stringify({ type: 'final', ...cachedResults })}\n`,
          {
            headers: {
              'Content-Type': 'application/x-ndjson; charset=utf-8',
              'Cache-Control': 'no-store'
            }
          }
        )
      }
      return NextResponse.json(cachedResults)
    }
    timer.set('cache', 'miss')

    const runSearch = (onPreview?: (p: SearXNGSearchResults) => void) =>
      advancedSearchXNGSearch(
        query,
        Math.min(maxResults, SEARXNG_MAX_RESULTS),
        searchDepth || SEARXNG_DEFAULT_DEPTH,
        Array.isArray(includeDomains) ? includeDomains : [],
        Array.isArray(excludeDomains) ? excludeDomains : [],
        effectiveTimeRange,
        typeof intent === 'string' ? (intent as SearchIntent) : 'general',
        Boolean(useOllama),
        typeof ollamaMaxResults === 'number' ? ollamaMaxResults : 5,
        timer,
        onPreview,
        chatId
      )

    const finish = async (results: SearXNGSearchResults) => {
      // Never cache an empty set. advancedSearchXNGSearch swallows its failures
      // and returns { results: [], images: [], number_of_results: 0 } — both
      // SearXNG primary and fallback down, an invalid response shape, or any
      // throw inside crawl/rerank all land here. Caching that persists one
      // transient blip for the whole hour-long TTL, and getCachedResults treats
      // `{results: []}` as a hit because it only tests truthiness.
      //
      // The basic-depth cache already refuses this, with the same reasoning
      // spelled out in lib/search/basic-search-cache.ts. The advanced path
      // simply never got the guard.
      if (results.results?.length) {
        await setCachedResults(cacheKey, results)
      }
      timer.set('returned', results.results?.length ?? 0)
      timer.emit()
    }

    // Streaming (opt-in via `stream: true`): NDJSON, one preview line as soon
    // as the fan-out resolves (~2s) and one final line when crawl and rerank
    // finish (~15-20s). Non-streaming callers get exactly today's behaviour.
    if (wantsStream) {
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const write = (obj: unknown) => {
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`))
            } catch {
              // client hung up mid-search; the search itself still completes
            }
          }
          try {
            const results = await runSearch(preview =>
              write({ type: 'preview', ...preview })
            )
            await finish(results)
            write({ type: 'final', ...results })
          } catch (error) {
            console.error('Advanced search error (stream):', error)
            write({
              type: 'final',
              results: [],
              query,
              images: [],
              number_of_results: 0
            })
          } finally {
            controller.close()
          }
        }
      })
      return new Response(body, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      })
    }

    const results = await runSearch()
    await finish(results)
    return NextResponse.json(results)
  } catch (error) {
    console.error('Advanced search error:', error)
    return NextResponse.json(
      {
        message: 'Internal Server Error',
        error: error instanceof Error ? error.message : String(error),
        query: query,
        results: [],
        images: [],
        number_of_results: 0
      },
      { status: 500 }
    )
  }
}

async function advancedSearchXNGSearch(
  query: string,
  maxResults: number = 10,
  searchDepth: 'basic' | 'advanced' = 'advanced',
  includeDomains: string[] = [],
  excludeDomains: string[] = [],
  timeRange?: string,
  intent: SearchIntent = 'general',
  useOllama = false,
  ollamaMaxResults = 5,
  timer: StageTimer = new StageTimer('latency:search'),
  /**
   * Called with the merged fan-out results BEFORE crawl and rerank — the
   * candidates are known ~2s in, but this function does not return for
   * another 15-20s. Lets the caller show sources immediately instead of
   * leaving the user staring at nothing while results we already have sit
   * unsent. Never throws into the search path.
   */
  onPreview?: (preview: SearXNGSearchResults) => void,
  // Join key for the shadow crop-position measurement (against [cite-urls]).
  chatId?: string
): Promise<SearXNGSearchResults> {
  const searchStartedAt = performance.now()
  if (!process.env.SEARXNG_API_URL && !process.env.SEARXNG_FALLBACK_API_URL) {
    throw new Error('SEARXNG_API_URL is not set in the environment variables')
  }

  const SEARXNG_ENGINES =
    process.env.SEARXNG_ENGINES || SEARXNG_ENGINES_ADVANCED
  const SEARXNG_TIME_RANGE = process.env.SEARXNG_TIME_RANGE || 'None'
  const SEARXNG_SAFESEARCH = process.env.SEARXNG_SAFESEARCH || '0'
  const SEARXNG_CRAWL_MULTIPLIER = parseInt(
    process.env.SEARXNG_CRAWL_MULTIPLIER || '4',
    10
  )

  try {
    // Page 1, always. SearXNG's `pageno` selects WHICH page to return, not how
    // many, so the inherited `ceil(maxResults / 10)` asked for page 2+ and
    // discarded page 1 entirely — throwing away the most relevant results on
    // every advanced search. It also made every query look like a paginating
    // bot (a human rarely goes to page 2, let alone every time), which shows up
    // as DuckDuckGo VQD CAPTCHAs and Brave/Startpage blocks. Breadth comes from
    // the engine fan-out and SEARXNG_CRAWL_MULTIPLIER, not from paging deeper.
    // Inherited from upstream bf554d6 (2024-08-21), not introduced here.
    const pageno = Math.max(1, parseInt(process.env.SEARXNG_PAGENO || '1', 10))

    // Fetches from SearXNG, automatically failing over to
    // SEARXNG_FALLBACK_API_URL if the primary instance is unreachable.
    const buildUrl = (baseUrl: string) => {
      const url = new URL(`${baseUrl}/search`)
      url.searchParams.append('q', query)
      url.searchParams.append('format', 'json')
      const intentCategory = intentToCategory(intent)
      url.searchParams.append(
        'categories',
        intentCategory ? `general,images,${intentCategory}` : 'general,images'
      )
      // Per-turn recency preference (query classifier) beats the static
      // env default.
      if (timeRange) {
        url.searchParams.append('time_range', timeRange)
      } else if (SEARXNG_TIME_RANGE !== 'None') {
        url.searchParams.append('time_range', SEARXNG_TIME_RANGE)
      }
      url.searchParams.append('safesearch', SEARXNG_SAFESEARCH)
      url.searchParams.append('engines', SEARXNG_ENGINES)
      url.searchParams.append('pageno', String(pageno))
      return url.toString()
    }

    // degoog is a complement, never a dependency: query it alongside SearXNG
    // via Promise.allSettled so a degoog failure (or it being unconfigured)
    // never fails the search — only a rejected SearXNG fetch does that.
    const DEGOOG_MAX = Math.min(20, maxResults * 2)
    const degoogUrl = (type: string) => (baseUrl: string) => {
      const u = new URL(`${baseUrl}/api/search`)
      u.searchParams.append('q', query)
      u.searchParams.append('type', type)
      u.searchParams.append('max_results', String(DEGOOG_MAX))
      return u.toString()
    }

    const [
      searxngSettled,
      degoogWebSettled,
      degoogNewsSettled,
      degoogImgSettled,
      ollamaSettled,
      tavilySettled,
      braveSettled,
      langSearchSettled
    ] = await timer.time('search_ms', () =>
      Promise.allSettled([
        fetchSearxngJson(buildUrl),
        DEGOOG_ENABLED
          ? fetchDegoogJson(degoogUrl('web'))
          : Promise.resolve(null),
        DEGOOG_ENABLED && intent === 'news'
          ? fetchDegoogJson(degoogUrl('news'))
          : Promise.resolve(null),
        // OFF by default. SearXNG already returns images in the SAME request
        // (its category list is ['general','images',...]) and both sources are
        // merged into one `images` array below, so the strip still renders
        // without this call — it only adds Google Images variety.
        //
        // It used to fire on EVERY search, and each degoog request fans out to
        // Google, Brave, Startpage and DDG internally. That doubled our
        // upstream engine load for images most turns never show, and burned
        // the per-IP quota degoog shares with SearXNG and ordinary browsing
        // (Brave returned 429 forty-six times in 12h). There is no 'images'
        // SearchIntent to gate on, so this is an explicit switch rather than a
        // condition that would silently never fire.
        DEGOOG_ENABLED && DEGOOG_IMAGES_ENABLED
          ? fetchDegoogJson(degoogUrl('images'))
          : Promise.resolve(null),
        useOllama
          ? fetchOllamaSearch(query, ollamaMaxResults)
          : Promise.resolve(null),
        // Tavily only on the advanced path (balanced/quality modes), budget-gated.
        searchDepth === 'advanced'
          ? maybeFetchTavily(query)
          : Promise.resolve(null),
        // Brave API on the advanced path too — block-immune, budget-gated.
        searchDepth === 'advanced'
          ? maybeFetchBrave(query)
          : Promise.resolve(null),
        // LangSearch, also block-immune. Advanced only: its free tier is 1 QPS,
        // which the basic path's concurrent fan-out would trip on its own.
        searchDepth === 'advanced'
          ? maybeFetchLangSearch(
              query,
              timeRange as 'day' | 'week' | 'month' | 'year' | undefined
            )
          : Promise.resolve(null)
      ])
    )

    if (searxngSettled.status === 'rejected') throw searxngSettled.reason
    const { data: rawData, baseUrlUsed: apiUrl } = searxngSettled.value

    const degoogOf = (
      s: PromiseSettledResult<{ data: unknown } | null>
    ): DegoogResponse['results'] => {
      if (s.status !== 'fulfilled' || !s.value) return []
      return (s.value.data as DegoogResponse).results ?? []
    }
    const degoogWeb = [
      ...degoogOf(degoogWebSettled),
      ...degoogOf(degoogNewsSettled)
    ]
    const degoogImages = degoogOf(degoogImgSettled)

    const ollamaResults: OllamaSearchResult[] =
      ollamaSettled.status === 'fulfilled' && ollamaSettled.value
        ? (ollamaSettled.value as OllamaSearchResult[])
        : []
    if (ollamaSettled.status === 'rejected') {
      console.warn(
        '[ollama] advanced web search failed, continuing without it:',
        ollamaSettled.reason
      )
    }

    const tavilyResults: TavilySearchResult[] =
      tavilySettled.status === 'fulfilled' && tavilySettled.value
        ? (tavilySettled.value as TavilySearchResult[])
        : []
    if (tavilySettled.status === 'rejected') {
      console.warn(
        '[tavily] advanced web search failed, continuing without it:',
        tavilySettled.reason
      )
    }

    const braveResults: BraveSearchResult[] =
      braveSettled.status === 'fulfilled' && braveSettled.value
        ? (braveSettled.value as BraveSearchResult[])
        : []
    if (braveSettled.status === 'rejected') {
      console.warn(
        '[brave] advanced web search failed, continuing without it:',
        braveSettled.reason
      )
    }

    const langSearchResults: LangSearchResult[] =
      langSearchSettled.status === 'fulfilled' && langSearchSettled.value
        ? (langSearchSettled.value as LangSearchResult[])
        : []
    if (langSearchSettled.status === 'rejected') {
      console.warn(
        '[langsearch] advanced web search failed, continuing without it:',
        langSearchSettled.reason
      )
    }

    // NOT extended with LangSearch urls: its `summary` is long but lossy
    // (lowercased, punctuation space-separated), so those pages still get
    // crawled for clean text. See merge-langsearch.ts.
    const prefetchedUrls = new Set(ollamaResults.map(r => r.url))

    const data = rawData as SearXNGResponse

    if (!data || !Array.isArray(data.results)) {
      console.error('Invalid response structure from SearXNG:', data)
      throw new Error('Invalid response structure from SearXNG')
    }

    // Full crawled text for conversation HISTORY, set only when excerpting
    // shrank what the model reads this turn. See rehydrate-full-content.ts.
    let fullGeneralResults: SearXNGResult[] | null = null
    let generalResults = data.results.filter(
      (result: SearXNGResult) => result && !result.img_src
    )

    // Apply domain filtering to SearXNG's own results. NOTE this is not
    // sufficient on its own — see applyDomainFilter after the merges below.
    generalResults = applyDomainFilter(
      generalResults,
      includeDomains,
      excludeDomains
    )

    // degoog parity: fold degoog web results into the candidate pool BEFORE
    // crawl+rerank so the advanced (deepest) search has the same source union
    // as the basic path. Cap at the crawl candidate size so niche degoog
    // results reach the crawler.
    if (degoogWeb.length > 0) {
      generalResults = mergeDegoogIntoSearxngResults(
        generalResults,
        degoogWeb,
        maxResults * SEARXNG_CRAWL_MULTIPLIER
      )
    }

    // Tavily is block-immune (runs on Tavily's own IPs), so fold it into the
    // candidate pool before crawl+rerank to recover the Google/Bing-tier
    // sources our IP-blocked SearXNG scrapers miss. Snippet-only, so — unlike
    // Ollama — these URLs are NOT marked prefetched and get crawled for full
    // content by the step below.
    if (tavilyResults.length > 0) {
      generalResults = mergeTavilyIntoSearxngResults(
        generalResults,
        tavilyResults,
        maxResults * SEARXNG_CRAWL_MULTIPLIER
      )
    }

    // Brave API: same reasoning as Tavily — block-immune, snippet-only, so it
    // joins the candidate pool before crawl+rerank and its URLs get crawled.
    if (braveResults.length > 0) {
      generalResults = mergeBraveIntoSearxngResults(
        generalResults,
        braveResults,
        maxResults * SEARXNG_CRAWL_MULTIPLIER
      )
    }

    // LangSearch: same treatment again — block-immune discovery, and its text
    // is bounded and lossy rather than clean page content, so its URLs join the
    // candidate pool and get crawled like Tavily's and Brave's.
    if (langSearchResults.length > 0) {
      generalResults = mergeLangSearchIntoSearxngResults(
        generalResults,
        langSearchResults,
        maxResults * SEARXNG_CRAWL_MULTIPLIER
      )
    }

    // Ollama results carry full content already — merge them into the candidate
    // pool so they're reranked alongside crawled searxng/degoog results. They
    // are tagged (prefetchedUrls) so the crawl step below skips them.
    if (ollamaResults.length > 0) {
      generalResults = mergeOllamaIntoSearxngResults(
        generalResults,
        ollamaResults,
        maxResults * SEARXNG_CRAWL_MULTIPLIER
      )
    }

    // Re-apply the domain filter across the FULL pool.
    //
    // The filter above only ever saw SearXNG's results, and five provider
    // merges run after it — degoog, tavily, brave, langsearch, ollama — none of
    // which receive the domain arguments at all (they are called with the bare
    // query). Worse, several of them PREPEND, so the unfiltered results led the
    // pool. A user saying "not pinterest" had pinterest stripped from SearXNG
    // and then merged straight back in from Brave or Tavily; include_domains
    // was worse still, since the pool was headed by results that matched
    // nothing the user asked for.
    generalResults = applyDomainFilter(
      generalResults,
      includeDomains,
      excludeDomains
    )

    // Pre-crawl ranks, hoisted so the returned_ranks telemetry below can still
    // see them after the advanced block closes. Empty unless the gate ran.
    let snippetRankByUrl = new Map<string, number>()

    if (searchDepth === 'advanced') {
      const pooledCandidates = generalResults.slice(
        0,
        maxResults * SEARXNG_CRAWL_MULTIPLIER
      )

      // Pre-crawl relevance gate. `pooledCandidates` is in MERGE order —
      // rank-interleaved per source — not relevance order, so without this the
      // crawler spends its budget on whatever the merge happened to surface.
      // Measured: 32 pages crawled to return 14, with crawl at 50-70% of the
      // turn. Fails open to `pooledCandidates` on any error; see snippet-gate.ts.
      const gate = await runSnippetGate(query, pooledCandidates, prefetchedUrls)
      const candidates = gate.candidates
      snippetRankByUrl = gate.rankByUrl
      timer.set('snippet_gate', gate.status)
      if (gate.status !== 'off') {
        timer.set('snippet_rank_ms', Math.round(gate.rankMs))
        timer.set('snippet_ranked', gate.ranked)
        timer.set('snippet_capped', gate.capped)
      }

      // Everything below (crawl, quality filter, rerank) takes 15-20s. These
      // candidates are already good enough to render as sources, so hand them
      // over now; the caller replaces them when the enriched set arrives.
      if (onPreview) {
        try {
          onPreview({
            results: generalResults.slice(0, maxResults).map(r => ({
              title: r.title || '',
              url: r.url || '',
              content: r.content || ''
            })),
            query,
            images: [],
            number_of_results: generalResults.length
          })
          timer.mark('preview_ms', performance.now() - searchStartedAt)
        } catch {
          // Telemetry/preview must never break a search.
        }
      }

      // Full-content enrichment: the self-hosted Crawl4AI server renders
      // every candidate in a real browser and returns clean markdown, in
      // one batched call. This is the whole point of self-hosting a
      // scraper — the legacy crawlPage path below is a raw HTTP GET plus
      // DOM scraping, which silently yields nothing on JS-rendered pages,
      // so the model ends up reasoning over snippets. Unmetered, so it
      // runs on every advanced turn. Falls back to crawlPage per-result
      // if Crawl4AI is unconfigured or unreachable.
      // Bound the browser budget: SearXNG's results are already ranked, so
      // spend it on the most promising ones. Anything past the cap — and
      // anything Crawl4AI can't render — still gets crawled by the cheap
      // legacy path, so no candidate is silently dropped.
      // Cover the whole candidate pool with Crawl4AI. A 3-arm A/B (2 runs
      // each, same query) measured returned SOURCES, not counts of work:
      //   enrich=24  -> 8.0 sources, 47s   (24 rendered, ~28 via JSDOM)
      //   enrich=48  -> 11.5 sources, 84s
      //   enrich=100 -> 13.0 sources, 106s (~50 rendered, ~4 via JSDOM)
      // Source counts separated cleanly across arms with no overlap, so the
      // effect is real despite ~2x run-to-run variance in wall-clock.
      //
      // The mechanism is yield, not volume: every arm "enriches" the same
      // pages, but pages scraped by the legacy JSDOM path frequently produce
      // content that fails isQualityContent and gets dropped, while a real
      // browser render succeeds. Sending pages to the renderer instead of the
      // scraper therefore BUYS sources -- the legacy path was quietly costing
      // them. Slower per turn, and that is the accepted trade.
      const MAX_ENRICH_URLS = Math.max(
        1,
        parseInt(process.env.MAX_ENRICH_URLS || '100', 10)
      )
      const toEnrich = candidates
        .filter(r => !prefetchedUrls.has(r.url))
        .slice(0, MAX_ENRICH_URLS)
      const beyondCap = candidates.length - toEnrich.length

      // Chunked + never-throws, so a slow chunk degrades to "those URLs
      // weren't enriched" instead of aborting the whole enrichment (an
      // earlier all-or-nothing version turned one timeout into a 140s
      // turn by re-crawling every candidate through the legacy path).
      timer.set('candidates', candidates.length)
      timer.set('crawled', toEnrich.length)
      const scraped = await timer.time('crawl_ms', () =>
        crawl4aiScrapeMany(
          toEnrich.map(r => r.url),
          // domcontentloaded, not networkidle: benchmarked 4.7s vs 26.4s on
          // a 16-URL batch, with MORE usable results. See Crawl4aiWaitUntil.
          {
            waitUntil: 'domcontentloaded',
            // Tunable: the sidecar has its own process pool, but it shares
            // this host's cores, so raising concurrency is not free above
            // some point. Verify host load before increasing.
            chunkSize: Math.max(
              1,
              parseInt(process.env.CRAWL4AI_CHUNK_SIZE || '8', 10)
            ),
            chunkTimeoutMs: CRAWL4AI_CHUNK_TIMEOUT_MS,
            // crawl_ms is the largest and most variable stage measured
            // (9.4s-111s). These say whether a slow batch was one bad chunk
            // or all of them, which have opposite fixes.
            onStats: stats => {
              for (const [k, v] of Object.entries(stats)) timer.set(k, v)
            }
          }
        )
      )
      const byUrl = new Map(scraped.map(s => [s.url, s]))

      // Shadow crop-position measurement (off unless SEARCH_CROP_POSITION_SHADOW).
      // Retains each crawled page's UNCROPPED content so, after the rerank, we
      // can log where each read source's most-relevant passage actually sits —
      // head (kept) vs tail (discarded by the crop). Never changes the answer.
      const cropPositionShadow =
        process.env.SEARCH_CROP_POSITION_SHADOW === 'true'
      const rawByUrl = new Map<string, string>()

      // Everything Crawl4AI did not cover (past the cap, or unrenderable)
      // falls to the legacy per-result crawl here. That is the majority of the
      // pool -- 57 of 73 candidates on a measured turn -- and it was the
      // single largest unaccounted block inside this route, so it is counted
      // and timed separately from crawl_ms.
      let legacyCrawled = 0
      let legacyTimedOut = 0
      let legacySkipped = 0
      const crawledResults = await timer.time('enrich_ms', () =>
        Promise.all(
          candidates.map(async result => {
            if (prefetchedUrls.has(result.url)) {
              // Ollama already fetched this — keep its content, don't crawl.
              return {
                ...result,
                content: highlightQueryTerms(
                  `${result.title}\n\n${result.content}`.substring(0, 10000),
                  query
                )
              }
            }
            const hit = byUrl.get(result.url)
            if (!hit) {
              // Past the cap, keep the snippet rather than spending local CPU
              // on a page the reranker will most likely discard anyway.
              if (legacyCrawled >= MAX_LEGACY_CRAWL_URLS) {
                legacySkipped++
                return result
              }
              legacyCrawled++
              // Bounded. crawlPage allows 20s per page and these run
              // concurrently, so one hanging page held the whole stage at
              // ~30s (measured: 20 pages, 1.5s/URL average vs 0.36s/URL for
              // the browser renderer). Past the budget we keep the search
              // snippet, which then faces the same isQualityContent filter
              // and reranker as everything else — a slow page degrades to
              // "not enriched", never to a stalled turn.
              return withDeadline(
                crawlPage(result, query, cropPositionShadow ? rawByUrl : undefined),
                LEGACY_CRAWL_BUDGET_MS,
                () => {
                  legacyTimedOut++
                  return result
                }
              )
            }
            const c4aiRaw = `${result.title}\n\n${hit.markdown}`
            if (cropPositionShadow) rawByUrl.set(result.url, c4aiRaw)
            return {
              ...result,
              content: highlightQueryTerms(c4aiRaw.substring(0, 10000), query)
            }
          })
        )
      )
      timer.set('legacy_crawled', legacyCrawled)
      timer.set('legacy_timed_out', legacyTimedOut)
      timer.set('legacy_skipped', legacySkipped)

      if (isCrawl4aiConfigured()) {
        console.log(
          `[advanced-search] crawl4ai enriched ${scraped.length}/${toEnrich.length}` +
            (beyondCap > 0 ? `, ${beyondCap} beyond cap` : '') +
            `; ${candidates.length - scraped.length} via legacy crawler`
        )
      }

      generalResults = crawledResults
        .filter(result => result !== null && isQualityContent(result.content))
        .map(result => result as SearXNGResult)

      // Relevance reranking, best-available first:
      //   cross-encoder service (jointly scores query+passage) →
      //   bi-encoder cosine (local MiniLM) → keyword scorer.
      // Each tier degrades to the next on failure, so a reranker outage is
      // invisible. All three produce scores in [0,1] except the keyword
      // scorer, which sorts on its own scale.
      const docsForRerank = generalResults.map(result => ({
        // Strip <mark> highlight tags before scoring — markup isn't content.
        // The original (highlights intact for the UI) rides along.
        content: result.content.replace(/<\/?mark>/g, ''),
        original: result
      }))

      // Send the model each source's top-ranked passages rather than the whole
      // page. Measured: a research turn's prompt is ~82k tokens against ~6k for
      // a non-search turn on the same conversation, i.e. ~93% of the prompt is
      // crawled page text, costing 6.6-13.7s of prompt processing before the
      // first word appears. Source COUNT is unchanged — this trims bytes per
      // source, not sources.
      const excerptsEnabled = process.env.SEARCH_EXCERPTS_ENABLED === 'true'
      const applyReranked = (
        reranked: {
          doc: { original: SearXNGResult }
          score: number
          topPassages: RankedPassage[]
        }[],
        minScore: number
      ) => {
        const kept = reranked.filter(r => r.score >= minScore)
        generalResults = kept.map(r =>
          excerptsEnabled
            ? {
                ...r.doc.original,
                content: buildExcerptContent(
                  r.topPassages,
                  r.doc.original.content
                )
              }
            : r.doc.original
        )
        // Full text for conversation HISTORY. The excerpt above is what the
        // model reads this turn; this is what gets persisted, so a follow-up
        // turn still has the depth to answer from context instead of searching
        // again. Only populated when excerpting actually changed something.
        fullGeneralResults = excerptsEnabled
          ? kept.map(r => r.doc.original)
          : null
      }

      // Bracketed rather than wrapped: the phase is two tiers with a fallback
      // between them, and what matters is the total the user waits for.
      const rerankStart = performance.now()
      let rerankTier = 'none'
      let reranked = false
      if (isCrossEncoderConfigured()) {
        try {
          const out = await rerankByCrossEncoder(
            docsForRerank,
            query,
            maxResults
          )
          // Cross-encoder [0,1]; the floor only drops CLEAR junk (near-zero
          // scores) — the answering model does the fine-grained judging.
          // 0.1, not 0.3: with max_length=128 truncation, genuinely-relevant
          // passages can score in the 0.1-0.4 range, and 0.3 over-filtered
          // ~15-20% of real queries into the bi-encoder fallback (they lost
          // the cross-encoder benefit). 0.1 keeps them while still dropping
          // obvious off-topic pages.
          applyReranked(out, 0.1)
          // Guard: if the floor filtered EVERYTHING out, don't return an
          // empty result set — fall through to the bi-encoder tier (which
          // uses a looser 0.2 floor) rather than answering with no sources.
          if (generalResults.length > 0) {
            reranked = true
            rerankTier = 'cross-encoder'
            console.log(
              `[advanced-search] cross-encoder reranked ${out.length}/${docsForRerank.length}`
            )
          } else {
            console.log(
              '[advanced-search] cross-encoder filtered all results below floor, falling back to bi-encoder'
            )
          }
        } catch (error) {
          console.error(
            '[advanced-search] cross-encoder failed, falling back to bi-encoder:',
            error
          )
        }
      }

      if (!reranked) {
        try {
          const out = await rerankByEmbedding(docsForRerank, query, maxResults)
          applyReranked(out, 0.2)
          reranked = true
          rerankTier = 'embedding'
        } catch (error) {
          console.error(
            '[advanced-search] embedding rerank failed, using keyword scorer:',
            error
          )
          const MIN_RELEVANCE_SCORE = 10
          // Score the ORIGINAL pool, not generalResults.
          //
          // generalResults is mutated by applyReranked. If the cross-encoder
          // ran and its 0.1 floor filtered everything, it is already [] — that
          // is the documented fall-through to this tier — so scoring it here
          // returned zero sources whenever the bi-encoder ALSO threw (model
          // load, OOM). Both other tiers read docsForRerank; this was the only
          // consumer of mutated state, which is why it was the only one that
          // could silently return nothing.
          generalResults = docsForRerank
            .map(d => d.original)
            .map(result => ({
              ...result,
              score: calculateRelevanceScore(result, query)
            }))
            .filter(result => result.score >= MIN_RELEVANCE_SCORE)
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults)
          rerankTier = 'keyword'
        }
      }

      timer.mark('rerank_ms', performance.now() - rerankStart)
      timer.set('rerank_tier', rerankTier)
      timer.set('rerank_docs', docsForRerank.length)

      // Shadow: after the rerank, log where each reranked source's most-relevant
      // passage sits in its FULL page (head kept vs tail cropped). after() runs
      // it off the response path; measureCropPositions swallows all errors.
      if (cropPositionShadow && generalResults.length > 0) {
        const shadowSources = generalResults
          .map(r => ({ url: r.url, rawContent: rawByUrl.get(r.url) }))
          .filter(
            (s): s is { url: string; rawContent: string } =>
              typeof s.rawContent === 'string'
          )
        if (shadowSources.length > 0) {
          try {
            after(() => measureCropPositions(query, shadowSources, chatId))
          } catch {
            /* shadow registration is best-effort */
          }
        }
      }
    }

    generalResults = generalResults.slice(0, maxResults)

    // Where each source we actually returned ranked BEFORE the crawl. This is
    // the entire basis for choosing SEARCH_SNIPPET_GATE_TOP_N, and it is only
    // meaningful while the gate still changes nothing — hence shadow mode.
    if (snippetRankByUrl.size > 0) {
      timer.set(
        'returned_ranks',
        buildReturnedRanks(generalResults, snippetRankByUrl)
      )
    }

    const imageResults = (data.results || [])
      .filter((result: SearXNGResult) => result && result.img_src)
      .slice(0, maxResults)

    return {
      results: generalResults.map(
        (result: SearXNGResult): SearchResultItem => ({
          title: result.title || '',
          url: result.url || '',
          content: result.content || ''
        })
      ),
      // Present only when excerpting shrank the payload. Consumers persist
      // this instead of `results` so history keeps full depth.
      ...(fullGeneralResults !== null
        ? {
            fullResults: (fullGeneralResults as SearXNGResult[])
              .slice(0, maxResults)
              .map(
                (result: SearXNGResult): SearchResultItem => ({
                  title: result.title || '',
                  url: result.url || '',
                  content: result.content || ''
                })
              )
          }
        : {}),
      query: data.query || query,
      images: Array.from(
        new Set([
          ...imageResults
            .map((result: SearXNGResult) => {
              const imgSrc = result.img_src || ''
              return imgSrc.startsWith('http') ? imgSrc : `${apiUrl}${imgSrc}`
            })
            .filter(Boolean),
          ...degoogImages
            .map(r =>
              resolveDegoogUrl(
                r.imageUrl || r.thumbnail || '',
                process.env.DEGOOG_API_URL ?? ''
              )
            )
            .filter(Boolean)
        ])
      ).slice(0, maxResults),
      number_of_results: data.number_of_results || generalResults.length
    }
  } catch (error) {
    console.error('SearchXNG API error:', error)
    return {
      results: [],
      query: query,
      images: [],
      number_of_results: 0
    }
  }
}

async function crawlPage(
  result: SearXNGResult,
  query: string,
  // Shadow crop-position: capture the uncropped legacy-crawled text (keyed by
  // url) so [crop-pos] covers legacy pages too, not just the crawl4ai path.
  rawSink?: Map<string, string>
): Promise<SearXNGResult> {
  try {
    const html = await fetchHtmlWithTimeout(result.url, 20000)

    // Readability first — cleaner article extraction than the manual DOM
    // walk below (which stays as the fallback for pages where Readability
    // finds no article node).
    const readable = extractReadableContent(html, result.url)
    if (readable && readable.text.length >= MIN_CONTENT_LENGTH) {
      const combinedRaw = [result.title, readable.title, readable.text]
        .filter(Boolean)
        .join('\n\n')
      rawSink?.set(result.url, combinedRaw)
      const combined = combinedRaw.substring(0, 10000)
      result.content = highlightQueryTerms(combined, query)
      if (readable.publishedDate) {
        const date = new Date(readable.publishedDate)
        if (!isNaN(date.getTime())) {
          result.publishedDate = date.toISOString()
        }
      }
      return result
    }

    // virtual console to suppress JSDOM warnings
    const virtualConsole = new VirtualConsole()
    virtualConsole.on('error', () => {})
    virtualConsole.on('warn', () => {})

    // NO `resources: 'usable'`. That setting makes JSDOM fetch every external
    // subresource (images, stylesheets, iframes) while parsing — network work
    // whose results this function then throws away, since all it reads is
    // textContent. It is also the expensive half of a path that runs ON the
    // Node event loop, so it stalls unrelated requests too. Dropping it
    // changes no extracted text: the walk below only reads text nodes, and
    // Readability (tried first, above) never needed subresources either.
    const dom = new JSDOM(html, {
      runScripts: 'outside-only',
      virtualConsole
    })
    const document = dom.window.document

    // Remove script, style, nav, header, and footer elements
    document
      .querySelectorAll('script, style, nav, header, footer')
      .forEach((el: Element) => el.remove())

    const mainContent =
      document.querySelector('main') ||
      document.querySelector('article') ||
      document.querySelector('.content') ||
      document.querySelector('#content') ||
      document.body

    if (mainContent) {
      // Prioritize specific content elements
      const priorityElements = mainContent.querySelectorAll('h1, h2, h3, p')
      let extractedText = Array.from(priorityElements)
        .map(el => el.textContent?.trim())
        .filter(Boolean)
        .join('\n\n')

      // If not enough content, fall back to other elements
      if (extractedText.length < 500) {
        const contentElements = mainContent.querySelectorAll(
          'h4, h5, h6, li, td, th, blockquote, pre, code'
        )
        extractedText +=
          '\n\n' +
          Array.from(contentElements)
            .map(el => el.textContent?.trim())
            .filter(Boolean)
            .join('\n\n')
      }

      // Extract metadata
      const metaDescription =
        document
          .querySelector('meta[name="description"]')
          ?.getAttribute('content') || ''
      const metaKeywords =
        document
          .querySelector('meta[name="keywords"]')
          ?.getAttribute('content') || ''
      const ogTitle =
        document
          .querySelector('meta[property="og:title"]')
          ?.getAttribute('content') || ''
      const ogDescription =
        document
          .querySelector('meta[property="og:description"]')
          ?.getAttribute('content') || ''

      // Combine metadata with extracted text
      extractedText = `${result.title}\n\n${ogTitle}\n\n${metaDescription}\n\n${ogDescription}\n\n${metaKeywords}\n\n${extractedText}`

      rawSink?.set(result.url, extractedText)
      // Limit the extracted text to 10000 characters
      extractedText = extractedText.substring(0, 10000)

      // Highlight query terms in the content
      result.content = highlightQueryTerms(extractedText, query)

      // Extract publication date
      const publishedDate = extractPublicationDate(document)
      if (publishedDate) {
        result.publishedDate = publishedDate.toISOString()
      }
    }

    return result
  } catch (error) {
    console.error(`Error crawling ${result.url}:`, error)
    return {
      ...result,
      content: result.content || 'Content unavailable due to crawling error.'
    }
  }
}

function highlightQueryTerms(content: string, query: string): string {
  try {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter(term => term.length > 2)
      .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) // Escape special characters

    let highlightedContent = content

    terms.forEach(term => {
      const regex = new RegExp(`\\b${term}\\b`, 'gi')
      highlightedContent = highlightedContent.replace(
        regex,
        match => `<mark>${match}</mark>`
      )
    })

    return highlightedContent
  } catch (error) {
    //console.error('Error in highlightQueryTerms:', error)
    return content // Return original content if highlighting fails
  }
}

function calculateRelevanceScore(result: SearXNGResult, query: string): number {
  try {
    const lowercaseContent = result.content.toLowerCase()
    const lowercaseQuery = query.toLowerCase()
    const queryWords = lowercaseQuery
      .split(/\s+/)
      .filter(word => word.length > 2)
      .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) // Escape special characters

    let score = 0

    // Check for exact phrase match
    if (lowercaseContent.includes(lowercaseQuery)) {
      score += 30
    }

    // Check for individual word matches
    queryWords.forEach(word => {
      const regex = new RegExp(`\\b${word}\\b`, 'g')
      const wordCount = (lowercaseContent.match(regex) || []).length
      score += wordCount * 3
    })

    // Boost score for matches in the title
    const lowercaseTitle = result.title.toLowerCase()
    if (lowercaseTitle.includes(lowercaseQuery)) {
      score += 20
    }

    queryWords.forEach(word => {
      const regex = new RegExp(`\\b${word}\\b`, 'g')
      if (lowercaseTitle.match(regex)) {
        score += 10
      }
    })

    // Boost score for recent content (if available)
    if (result.publishedDate) {
      const publishDate = new Date(result.publishedDate)
      const now = new Date()
      const daysSincePublished =
        (now.getTime() - publishDate.getTime()) / (1000 * 3600 * 24)
      if (daysSincePublished < 30) {
        score += 15
      } else if (daysSincePublished < 90) {
        score += 10
      } else if (daysSincePublished < 365) {
        score += 5
      }
    }

    // Penalize very short content
    if (result.content.length < 200) {
      score -= 10
    } else if (result.content.length > 1000) {
      score += 5
    }

    // Boost score for content with more highlighted terms
    const highlightCount = (result.content.match(/<mark>/g) || []).length
    score += highlightCount * 2

    return score
  } catch (error) {
    //console.error('Error in calculateRelevanceScore:', error)
    return 0 // Return 0 if scoring fails
  }
}

function extractPublicationDate(document: Document): Date | null {
  const dateSelectors = [
    'meta[name="article:published_time"]',
    'meta[property="article:published_time"]',
    'meta[name="publication-date"]',
    'meta[name="date"]',
    'time[datetime]',
    'time[pubdate]'
  ]

  for (const selector of dateSelectors) {
    const element = document.querySelector(selector)
    if (element) {
      const dateStr =
        element.getAttribute('content') ||
        element.getAttribute('datetime') ||
        element.getAttribute('pubdate')
      if (dateStr) {
        const date = new Date(dateStr)
        if (!isNaN(date.getTime())) {
          return date
        }
      }
    }
  }

  return null
}

const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: true // change to false if you want to ignore SSL certificate errors
  //but use this with caution.
})

async function fetchHtmlWithTimeout(
  url: string,
  timeoutMs: number
): Promise<string> {
  try {
    return await Promise.race([
      fetchHtml(url),
      timeout(timeoutMs, `Fetching ${url} timed out after ${timeoutMs}ms`)
    ])
  } catch (error) {
    console.error(`Error fetching ${url}:`, error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return `<html><body>Error fetching content: ${errorMessage}</body></html>`
  }
}

function fetchHtml(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https:') ? https : http
    const agent = url.startsWith('https:') ? httpsAgent : httpAgent
    const request = protocol.get(url, { agent }, res => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        // Handle redirects
        fetchHtml(new URL(res.headers.location, url).toString())
          .then(resolve)
          .catch(reject)
        return
      }
      // Refuse non-pages BEFORE downloading them. Without this a PDF gets
      // pulled in full, concatenated into a JS string, and parsed as HTML by
      // Readability + JSDOM — burning event-loop CPU to produce junk that
      // fails isQualityContent anyway. These are precisely Crawl4AI's per-page
      // failures (PDFs, antibot walls), i.e. the tail that reaches this path.
      const contentType = res.headers['content-type']
      if (!isParseableContentType(contentType)) {
        res.destroy()
        reject(new Error(`Unsupported content-type: ${contentType}`))
        return
      }

      let data = ''
      let bytes = 0
      res.on('data', chunk => {
        // Stop at the size cap too: content-type alone does not bound a
        // pathologically large page, and the parse cost scales with it.
        bytes += chunk.length
        if (bytes > MAX_PARSEABLE_BYTES) {
          res.destroy()
          reject(new Error(`Response exceeded ${MAX_PARSEABLE_BYTES} bytes`))
          return
        }
        data += chunk
      })
      res.on('end', () => resolve(data))
    })
    request.on('error', error => {
      //console.error(`Error fetching ${url}:`, error)
      reject(error)
    })
    request.on('timeout', () => {
      request.destroy()
      //reject(new Error(`Request timed out for ${url}`))
      resolve('')
    })
    request.setTimeout(10000) // 10 second timeout
  })
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(message))
    }, ms)
  })
}
