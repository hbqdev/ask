// Client for Tavily search, used as an additional block-immune source merged
// into the ADVANCED search path (balanced/quality modes). Tavily runs the
// query on its own servers, so it egresses from Tavily's IPs — immune to the
// Google/Brave/DDG-style anti-bot blocking that hits our self-hosted SearXNG
// engines. Unlike Ollama/degoog it is METERED (free tier ~1000 searches/mo),
// so the caller budget-gates it (see app/api/advanced-search/route.ts).
//
// We request search_depth 'basic' (1 credit; 'advanced' would cost 2) because
// the advanced route crawls the returned URLs with Crawl4AI for full content
// anyway — we only need Tavily for its block-immune URL discovery + snippets.
//
// Mirrors ollama-search-client's null-when-unconfigured / throw-on-failure /
// circuit-breaker contract so it drops cleanly into the same Promise.allSettled
// fan-out.

const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search'
const DEFAULT_TIMEOUT_MS = 10_000
const BREAKER_COOLDOWN_MS = 30_000

let downUntil = 0

export interface TavilySearchResult {
  title: string
  url: string
  content: string
}

export function isTavilySearchConfigured(): boolean {
  return Boolean(process.env.TAVILY_API_KEY)
}

/**
 * Query Tavily search. Returns `null` when unconfigured (callers treat Tavily
 * as optional). Throws on timeout/non-OK/network so callers can degrade to
 * searxng+degoog+ollama. A short circuit-breaker cooldown suppresses repeated
 * attempts during an outage. Does NOT enforce the monthly budget — that is the
 * caller's responsibility, so a budget-denied search never reaches here.
 */
export async function fetchTavilySearch(
  query: string,
  maxResults: number,
  options: { timeoutMs?: number } = {}
): Promise<TavilySearchResult[] | null> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) return null

  if (Date.now() < downUntil) {
    throw new Error('tavily search is in circuit-breaker cooldown')
  }

  const envTimeout = Number(process.env.TAVILY_MERGE_TIMEOUT_MS)
  const timeoutMs =
    options.timeoutMs ??
    (Number.isFinite(envTimeout) && envTimeout > 0
      ? envTimeout
      : DEFAULT_TIMEOUT_MS)

  // Tavily requires a minimum of 5 characters in the query.
  const filledQuery =
    query.length < 5 ? query + ' '.repeat(5 - query.length) : query

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(TAVILY_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: filledQuery,
        max_results: Math.max(maxResults, 5),
        search_depth: 'basic',
        include_images: false,
        include_answer: false
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`tavily search responded with ${response.status}`)
    }
    const json = (await response.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>
    }
    const results = (json.results ?? [])
      .filter(
        (r): r is { url: string; title?: string; content?: string } =>
          Boolean(r) && typeof r.url === 'string' && r.url.length > 0
      )
      .map(r => ({
        title: r.title ?? '',
        url: r.url,
        content: r.content ?? ''
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
