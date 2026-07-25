// Client for the Brave Search API, merged into the ADVANCED search path as a
// block-immune source.
//
// Why this matters here: every OTHER general source we have is scraped from our
// residential IP and is therefore hostage to IP reputation — Google answers 403
// "unusual traffic", DuckDuckGo and Startpage serve CAPTCHAs, and scraped Brave
// returns 429. The Brave *API* runs the query on Brave's own infrastructure
// against a subscribed quota, so none of that applies to it. It is the only
// general engine that cannot be blocked by what our IP has been doing.
//
// Metered (free tier is ~2,000 queries/month at 1 query/second), so the caller
// budget-gates it exactly like Tavily — see app/api/advanced-search/route.ts.
//
// Mirrors the tavily-search-client contract — null-when-unconfigured,
// throw-on-failure, short circuit-breaker — so it drops into the same
// Promise.allSettled fan-out without special handling.

const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
const DEFAULT_TIMEOUT_MS = 10_000
const BREAKER_COOLDOWN_MS = 30_000
/** Brave rejects count > 20. */
const MAX_COUNT = 20

let downUntil = 0

export interface BraveSearchResult {
  title: string
  url: string
  content: string
}

export function isBraveSearchConfigured(): boolean {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY)
}

/** Test seam: the breaker is module state and would leak between cases. */
export function __resetBraveBreakerForTests(): void {
  downUntil = 0
}

/**
 * Query the Brave Search API. Returns `null` when unconfigured (callers treat
 * Brave as optional). Throws on timeout/non-OK/network so callers can degrade to
 * searxng+ollama+tavily. Does NOT enforce the monthly budget — that is the
 * caller's job, so a budget-denied search never reaches here.
 */
export async function fetchBraveSearch(
  query: string,
  maxResults: number,
  options: { timeoutMs?: number } = {}
): Promise<BraveSearchResult[] | null> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY
  if (!apiKey) return null

  if (Date.now() < downUntil) {
    throw new Error('brave search is in circuit-breaker cooldown')
  }

  const envTimeout = Number(process.env.BRAVE_MERGE_TIMEOUT_MS)
  const timeoutMs =
    options.timeoutMs ??
    (Number.isFinite(envTimeout) && envTimeout > 0
      ? envTimeout
      : DEFAULT_TIMEOUT_MS)

  const url = new URL(BRAVE_SEARCH_ENDPOINT)
  url.searchParams.set('q', query)
  url.searchParams.set(
    'count',
    String(Math.min(Math.max(maxResults, 1), MAX_COUNT))
  )

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        // Header, never a query param — a key in the URL ends up in logs.
        'X-Subscription-Token': apiKey
      },
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`brave search responded with ${response.status}`)
    }
    const json = (await response.json()) as {
      web?: {
        results?: Array<{ title?: string; url?: string; description?: string }>
      }
    }
    const results = (json.web?.results ?? [])
      .filter(
        (r): r is { url: string; title?: string; description?: string } =>
          Boolean(r) && typeof r.url === 'string' && r.url.length > 0
      )
      .map(r => ({
        title: r.title ?? '',
        url: r.url,
        content: r.description ?? ''
      }))
    downUntil = 0
    return results
  } catch (error) {
    downUntil = Date.now() + BREAKER_COOLDOWN_MS
    throw error
  } finally {
    clearTimeout(timer)
  }
}
