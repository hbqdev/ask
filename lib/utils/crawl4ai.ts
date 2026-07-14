/**
 * Client for the self-hosted Crawl4AI API server (selfhosted/crawl4ai) —
 * a real headless browser that renders JS and returns clean, LLM-ready
 * markdown. Unmetered, so it's the workhorse of the content pipeline:
 *
 *  - Fetch tool (lib/tools/fetch.ts): first rescue tier, above
 *    FlareSolverr and Firecrawl. Handles JS-rendered SPAs and most pages
 *    a plain fetch gets nothing useful from.
 *  - Advanced search (app/api/advanced-search/route.ts): full-content
 *    enrichment — every crawled result becomes rendered markdown rather
 *    than a raw-HTTP fetch that JS-heavy pages return empty.
 *
 * CRAWL4AI_URL example: http://crawl4ai:11235 (reachable container-to-
 * container over the shared-infra docker network; the service publishes
 * no host port). CRAWL4AI_API_TOKEN is required by the server (v0.9+
 * rejects unauthenticated requests to everything except /health).
 */

const DEFAULT_TIMEOUT_MS = 30_000

// How long to let the browser settle before extracting.
//
//  - 'domcontentloaded' — HTML parsed, no wait for stragglers. Benchmarked
//    on a 16-URL batch: 4.7s, 16/16 usable.
//  - 'networkidle' — waits for XHR/hydration to settle. Required for
//    client-rendered SPAs (bsky.app yields ~0 chars without it, ~49k
//    with), but pages with persistent connections (analytics beacons,
//    live feeds) never go idle and burn the full page_timeout: the same
//    16-URL batch took 26.4s and produced FEWER usable results (14/16).
//
// So: batch enrichment uses domcontentloaded (speed, and it's mostly
// articles), single-URL fetch uses networkidle (the user asked for that
// exact page — correctness beats latency, and SPAs are common there).
export type Crawl4aiWaitUntil = 'domcontentloaded' | 'networkidle'

export type Crawl4aiResult = {
  markdown: string
  title?: string
  url: string
}

export function isCrawl4aiConfigured(): boolean {
  return Boolean(process.env.CRAWL4AI_URL && process.env.CRAWL4AI_API_TOKEN)
}

// The server nests markdown as either a plain string or an object with
// raw/fit variants depending on the content filter in play. fit_markdown
// is the noise-filtered version (nav/footer/boilerplate stripped) and is
// what we want when present — falling back to raw markdown otherwise.
function extractMarkdown(result: unknown): string {
  const md = (result as { markdown?: unknown })?.markdown
  if (typeof md === 'string') return md
  if (md && typeof md === 'object') {
    const m = md as { fit_markdown?: unknown; raw_markdown?: unknown }
    if (typeof m.fit_markdown === 'string' && m.fit_markdown.trim()) {
      return m.fit_markdown
    }
    if (typeof m.raw_markdown === 'string') return m.raw_markdown
  }
  return ''
}

/**
 * Scrape many URLs to markdown, chunked so one slow chunk can't sink the
 * whole set. Real search results are not a curated list: a few pages hang
 * until their per-page timeout, and a single request carrying all of them
 * blows any sane deadline. Chunks run concurrently, each with its own
 * timeout, and whatever comes back is kept — partial enrichment beats an
 * all-or-nothing abort.
 *
 * Never throws: a fully failed run returns [], and callers treat a missing
 * URL as "not enriched" (the fetch tool escalates to the next tier,
 * advanced search falls back to its legacy crawler for just that URL).
 */
export async function crawl4aiScrapeMany(
  urls: string[],
  options?: {
    chunkSize?: number
    chunkTimeoutMs?: number
    waitUntil?: Crawl4aiWaitUntil
  }
): Promise<Crawl4aiResult[]> {
  if (!isCrawl4aiConfigured() || urls.length === 0) return []

  const chunkSize = options?.chunkSize ?? 8
  const chunks: string[][] = []
  for (let i = 0; i < urls.length; i += chunkSize) {
    chunks.push(urls.slice(i, i + chunkSize))
  }

  // Generous per-chunk budget. A chunk that aborts loses ALL its work —
  // eight rendered pages thrown away — and the caller then pays again on
  // its fallback path, so an over-tight timeout is far more expensive than
  // a slow chunk. Real search results (heavy docs sites, GitHub, pages that
  // hang) routinely push a chunk of 8 past 30s even though a curated list
  // of 16 finishes in 5s.
  const settled = await Promise.allSettled(
    chunks.map(chunk =>
      crawl4aiScrape(chunk, {
        timeoutMs: options?.chunkTimeoutMs ?? 60_000,
        waitUntil: options?.waitUntil
      })
    )
  )

  return settled.flatMap(s => {
    if (s.status === 'fulfilled') return s.value
    console.error('[crawl4ai] chunk failed:', s.reason)
    return []
  })
}

/**
 * Scrape one or more URLs to markdown in a single request. Returns one
 * entry per URL that produced usable content; URLs that fail server-side
 * are simply absent from the result (the caller decides what to do about
 * a miss — the fetch tool escalates, advanced search drops the result).
 *
 * Throws only on transport/auth failure, i.e. "Crawl4AI itself is not
 * usable" — never on a single URL failing to render. Prefer
 * crawl4aiScrapeMany for anything larger than a handful of URLs.
 */
export async function crawl4aiScrape(
  urls: string[],
  options?: { timeoutMs?: number; waitUntil?: Crawl4aiWaitUntil }
): Promise<Crawl4aiResult[]> {
  const baseUrl = process.env.CRAWL4AI_URL
  const token = process.env.CRAWL4AI_API_TOKEN
  if (!baseUrl || !token) {
    throw new Error('CRAWL4AI_URL / CRAWL4AI_API_TOKEN are not configured')
  }
  if (urls.length === 0) return []

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs + 5_000)

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/crawl`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        urls,
        crawler_config: {
          type: 'CrawlerRunConfig',
          params: {
            stream: false,
            cache_mode: 'bypass',
            // Per-page budget inside the browser. Deliberately well under
            // the request timeout: dead/hanging pages are common in real
            // search results, and one of them must not eat the chunk's
            // whole budget.
            page_timeout: Math.min(timeoutMs, 12_000),
            wait_until: options?.waitUntil ?? 'networkidle'
          }
        }
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      throw new Error(`Crawl4AI HTTP ${response.status}`)
    }

    const json = (await response.json()) as {
      success?: boolean
      results?: Array<{ url?: string; metadata?: { title?: string } }>
    }

    return (json.results ?? [])
      .map(result => ({
        markdown: extractMarkdown(result),
        title: result.metadata?.title,
        url: result.url ?? ''
      }))
      .filter(r => r.markdown.trim().length > 0)
  } finally {
    clearTimeout(timeoutId)
  }
}

/** Single-URL convenience wrapper. Throws if the page yields no content. */
export async function crawl4aiScrapeOne(
  url: string,
  options?: { timeoutMs?: number }
): Promise<Crawl4aiResult> {
  const results = await crawl4aiScrape([url], options)
  const result = results[0]
  if (!result) {
    throw new Error('Crawl4AI returned no usable content')
  }
  return result
}
