// Client for LangSearch, an additional block-immune source merged into the
// ADVANCED search path. Like Tavily and Brave, the query runs on LangSearch's
// own infrastructure, so it egresses from their IPs and is unaffected by the
// anti-bot blocking that hits our self-hosted SearXNG engines.
//
// ADVANCED PATH ONLY, and that is a hard constraint rather than a preference:
// the free tier is 1 QPS / 1000 requests per day. The basic path fans several
// searches out concurrently per turn, which would trip the rate limit
// immediately. One call per turn on the advanced path fits comfortably.
//
// TWO RESPONSE QUIRKS, both verified against the live API on 2026-07-27:
//
//   1. The status lives in the BODY as `code`, independent of the HTTP status.
//      A call returned HTTP 200 with body `{"code":500}` during testing, so
//      checking response.ok alone would have parsed a failure as an empty
//      result set.
//   2. `id` is not a document id -- it is
//      "https://api.langsearch.com/v1/web-search#N", the 1-based ordinal
//      within THIS response. Useless for dedup; callers key on url.
//
// Mirrors tavily-search-client's null-when-unconfigured / throw-on-failure /
// circuit-breaker contract so it drops into the same Promise.allSettled fan-out.

const LANGSEARCH_ENDPOINT = 'https://api.langsearch.com/v1/web-search'
const DEFAULT_TIMEOUT_MS = 10_000
const BREAKER_COOLDOWN_MS = 30_000

/** The API rejects more than 10 per call. */
export const LANGSEARCH_MAX_COUNT = 10

// `summary` comes back around 15-18k chars -- close to full page text, and far
// more than Tavily's snippet. It is NOT clean prose though: it arrives
// lowercased with punctuation space-separated ("logical replication of ddls \n
// fujitsu aws"). Good enough to judge relevance on, too degraded to hand to the
// answering model as page content, which is why these URLs are NOT marked
// prefetched and still get crawled. Bounded so ten results cannot push ~180k
// chars of lossy text through the snippet gate and reranker.
const CONTENT_CHARS = 2_000

let downUntil = 0

export interface LangSearchResult {
  title: string
  url: string
  content: string
}

export function isLangSearchConfigured(): boolean {
  return Boolean(process.env.LANGSEARCH_API_KEY)
}

/** Ask's time_range -> LangSearch's freshness enum. */
export function toLangSearchFreshness(
  timeRange?: 'day' | 'week' | 'month' | 'year'
): 'oneDay' | 'oneWeek' | 'oneMonth' | 'oneYear' | 'noLimit' {
  switch (timeRange) {
    case 'day':
      return 'oneDay'
    case 'week':
      return 'oneWeek'
    case 'month':
      return 'oneMonth'
    case 'year':
      return 'oneYear'
    default:
      return 'noLimit'
  }
}

type LangSearchItem = {
  name?: string
  url?: string
  snippet?: string
  summary?: string
}

/** Exported for tests: maps the raw envelope to our result shape. */
export function parseLangSearchResponse(json: unknown): LangSearchResult[] {
  const body = json as {
    code?: number
    msg?: string | null
    data?: { webPages?: { value?: LangSearchItem[] } }
  }
  // Body status is authoritative — see the header note.
  if (typeof body?.code === 'number' && body.code !== 200) {
    throw new Error(
      `langsearch responded with body code ${body.code}${body.msg ? `: ${body.msg}` : ''}`
    )
  }
  const items = body?.data?.webPages?.value
  if (!Array.isArray(items)) return []

  const out: LangSearchResult[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const url = typeof item?.url === 'string' ? item.url : ''
    if (!url || seen.has(url)) continue
    seen.add(url)
    // summary is richer than snippet but may be absent; either way bounded.
    const text = item.summary || item.snippet || ''
    out.push({
      title: item.name || '',
      url,
      content: text.length > CONTENT_CHARS ? text.slice(0, CONTENT_CHARS) : text
    })
  }
  return out
}

/**
 * Query LangSearch. Returns `null` when unconfigured (callers treat it as
 * optional). Throws on timeout / non-OK / body-code failure so callers can
 * degrade to the other sources. A short circuit-breaker cooldown suppresses
 * repeated attempts during an outage — which matters more here than elsewhere,
 * because the free tier's 1 QPS means a retry storm is itself the failure.
 * Does NOT enforce the daily budget; that is the caller's job.
 */
export async function fetchLangSearch(
  query: string,
  maxResults: number,
  options: {
    timeoutMs?: number
    timeRange?: 'day' | 'week' | 'month' | 'year'
  } = {}
): Promise<LangSearchResult[] | null> {
  const apiKey = process.env.LANGSEARCH_API_KEY
  if (!apiKey) return null

  if (Date.now() < downUntil) {
    throw new Error('langsearch is in circuit-breaker cooldown')
  }

  const envTimeout = Number(process.env.LANGSEARCH_TIMEOUT_MS)
  const timeoutMs =
    options.timeoutMs ??
    (Number.isFinite(envTimeout) && envTimeout > 0
      ? envTimeout
      : DEFAULT_TIMEOUT_MS)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(LANGSEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query,
        freshness: toLangSearchFreshness(options.timeRange),
        // Free: metering is per request, not per result, so the richer text
        // costs nothing extra.
        summary: true,
        count: Math.min(Math.max(maxResults, 1), LANGSEARCH_MAX_COUNT)
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`langsearch responded with ${response.status}`)
    }
    const results = parseLangSearchResponse(await response.json())
    downUntil = 0
    return results
  } catch (error) {
    downUntil = Date.now() + BREAKER_COOLDOWN_MS
    throw error
  } finally {
    clearTimeout(timer)
  }
}
