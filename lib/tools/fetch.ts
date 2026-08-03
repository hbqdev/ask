import { tool, UIToolInvocation } from 'ai'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  fetchTranscript,
  toPlainText,
  YoutubeTranscriptNotAvailableLanguageError
} from 'youtube-transcript-plus'

import { FirecrawlClient } from '@/lib/firecrawl'
import {
  FETCH_MAX_URLS,
  fetchSchema,
  normalizeFetchUrls
} from '@/lib/schema/fetch'
import { SearchResults as SearchResultsType } from '@/lib/types'
import { crawl4aiScrapeOne, isCrawl4aiConfigured } from '@/lib/utils/crawl4ai'
import {
  extractReadableContent,
  MIN_CONTENT_LENGTH
} from '@/lib/utils/extract-content'
import {
  flaresolverrGet,
  isFlaresolverrConfigured
} from '@/lib/utils/flaresolverr'
import { mapWithConcurrency } from '@/lib/utils/map-with-concurrency'
import { retryWithBackoff } from '@/lib/utils/retry'
import { assertUrlAllowed } from '@/lib/utils/ssrf-guard'
import { logToolPayload } from '@/lib/utils/usage-logging'
import { withDeadline } from '@/lib/utils/with-deadline'

const execFileAsync = promisify(execFile)

const CONTENT_CHARACTER_LIMIT = 50000
const TITLE_CHARACTER_LIMIT = 100

/**
 * Hard ceiling on ONE fetch tool call, covering the whole rescue chain.
 *
 * The chain is strictly serial — plain fetch → Crawl4AI → FlareSolverr →
 * Tavily extract → Firecrawl — and each tier only runs because the previous
 * one failed. Before this bound the arithmetic was: 31.5s (10s x 3 attempts +
 * backoff) + 35s + 35s = 101.5s before even reaching the last two tiers, which
 * had no timeout at all. Measured consequence: single turns spent 80.1s and
 * 74.2s inside fetch, one of them across just 3 tool calls.
 *
 * 40s is deliberately above the sum of the two browser tiers (~35s each is
 * their worst case, but their typical is a few seconds) so a genuinely slow
 * page still gets rescued, while a hopeless one is abandoned long before it
 * can dominate the turn.
 *
 * Note this bounds the CALLER's wait, not the underlying request: withDeadline
 * resolves the fallback and lets the in-flight tier finish in the background.
 * Per-tier AbortControllers below are what actually cancel work.
 */
const FETCH_TOTAL_DEADLINE_MS = Math.max(
  5_000,
  parseInt(process.env.FETCH_TOTAL_DEADLINE_MS || '40000', 10)
)

/**
 * Per-tier timeout for the two tiers that had none: Tavily extract and
 * Firecrawl. Both are LAST-RESORT tiers reached only after three cheaper ones
 * failed, so the page has already signalled three times that it is unlikely to
 * yield — spending unbounded time there is the worst trade in the chain. They
 * are also the two PAID tiers.
 */
const FETCH_RESCUE_TIER_TIMEOUT_MS = 15_000

// Matches youtube.com/watch, youtube.com/shorts, youtu.be, and m.youtube.com
// variants. Anything else falls through to the regular/api fetch paths.
const YOUTUBE_URL_PATTERN =
  /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch|shorts\/)|youtu\.be\/)/i

export function isYoutubeUrl(url: string): boolean {
  return YOUTUBE_URL_PATTERN.test(url)
}

export async function fetchYoutubeTranscriptData(
  url: string
): Promise<SearchResultsType> {
  // Prefer English captions since the model's citations and the app's UI
  // are English-first; some videos only expose non-English tracks (e.g.
  // Arabic subtitles on an English-language talk), so fall back to
  // whatever track is available rather than failing the whole fetch.
  let videoDetails, segments
  try {
    ;({ videoDetails, segments } = await fetchTranscript(url, {
      videoDetails: true,
      lang: 'en'
    }))
  } catch (error) {
    if (error instanceof YoutubeTranscriptNotAvailableLanguageError) {
      ;({ videoDetails, segments } = await fetchTranscript(url, {
        videoDetails: true
      }))
    } else {
      throw error
    }
  }

  const transcriptText = toPlainText(segments, ' ')
  const content =
    transcriptText.length > CONTENT_CHARACTER_LIMIT
      ? transcriptText.substring(0, CONTENT_CHARACTER_LIMIT) + '...[truncated]'
      : transcriptText

  const rawTitle = videoDetails.title || url
  const title =
    rawTitle.length > TITLE_CHARACTER_LIMIT
      ? rawTitle.substring(0, TITLE_CHARACTER_LIMIT) + '...'
      : rawTitle

  return {
    results: [
      {
        title,
        content,
        url
      }
    ],
    query: '',
    images: []
  }
}

// Some sites (verywellhealth.com, health.com, goodrx.com, etc.) intermittently
// 403 a plain fetch — observed to succeed on a bare retry seconds later, so
// this looks like bot-detection flakiness rather than a hard block. Retry
// HTTP-status failures with backoff; a genuinely blocked/unsupported URL
// still fails after all attempts and falls through to the "Fetch failed"
// placeholder below.
async function fetchWithRetry(url: string): Promise<Response> {
  return retryWithBackoff(
    async () => {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000) // 10 second timeout
      let response: Response
      try {
        response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Ask/1.0)',
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }
        })
      } finally {
        clearTimeout(timeoutId)
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      return response
    },
    {
      // Was 2 (i.e. THREE attempts, because retryWithBackoff loops
      // `attempt <= maxRetries`). Three identical plain-fetch attempts cost
      // 31.5s to learn what the first two already said, and every second spent
      // here delays the browser-based tiers that are the ones actually able to
      // rescue a JS-rendered or bot-walled page. One retry keeps the original
      // purpose -- those sites that intermittently 403 and succeed seconds
      // later -- at 20.5s worst case instead of 31.5s.
      maxRetries: 1,
      initialDelayMs: 500,
      shouldRetry: isRetryableFetchError
    }
  )
}

/**
 * Whether a plain-fetch failure could plausibly succeed on a retry.
 *
 * 404/410/401/400 are decisions, not hiccups: the server has told us what it
 * thinks and will say it again. Retrying them burns 10s each and postpones
 * Crawl4AI and FlareSolverr, the tiers that can actually clear a bot wall.
 *
 * 403 is the deliberate exception and must STAY retryable. It looks definitive
 * but is measured flakiness here: verywellhealth.com, health.com and goodrx.com
 * intermittently 403 a plain fetch and succeed on a bare retry seconds later
 * (see the comment on fetchWithRetry, and the transient-403 case in
 * fetch.test.ts). Treating it as final regressed that recovery.
 *
 * 408 and 429 are retryable too -- they explicitly mean "later". Non-HTTP
 * failures (timeouts, DNS, resets) stay retryable, which is the flakiness this
 * retry existed for in the first place.
 */
export function isRetryableFetchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/^HTTP (\d{3}):/)
  if (!match) return true
  const status = Number(match[1])
  // 403 = bot-detection flakiness on real sites; 408/429 = "try later".
  if (status === 403 || status === 408 || status === 429) return true
  return status < 400 || status >= 500
}

// Shared HTML → SearchResults conversion for every tier of the fetch
// chain that produces raw HTML (plain fetch, FlareSolverr). Readability
// first; falls back to the legacy regex stripping when no article node is
// found. Throws when the best extraction is still under
// MIN_CONTENT_LENGTH — a 200-with-nothing JS shell or bot interstitial
// must fail so the chain can escalate to the next tier.
function htmlToResults(html: string, url: string): SearchResultsType {
  const readable = extractReadableContent(html, url)

  let title: string
  let textContent: string

  if (readable && readable.text.length >= MIN_CONTENT_LENGTH) {
    title = readable.title || new URL(url).hostname
    textContent = readable.text
  } else {
    // Legacy regex extraction fallback
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
    title = titleMatch ? titleMatch[1].trim() : new URL(url).hostname

    let processedHtml = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')

    processedHtml = processedHtml
      .replace(/<img[^>]+alt\s*=\s*["']([^"']+)["'][^>]*>/gi, ' [IMAGE: $1] ')
      .replace(/<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi, ' [IMAGE] ')
      .replace(/<img[^>]*>/gi, ' [IMAGE] ')

    textContent = processedHtml
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  if (textContent.length < MIN_CONTENT_LENGTH) {
    throw new Error(
      `Extracted content too short (${textContent.length} chars) — likely a JS-rendered page or bot wall`
    )
  }

  const truncatedTitle =
    title.length > TITLE_CHARACTER_LIMIT
      ? title.substring(0, TITLE_CHARACTER_LIMIT) + '...'
      : title
  const truncatedContent =
    textContent.length > CONTENT_CHARACTER_LIMIT
      ? textContent.substring(0, CONTENT_CHARACTER_LIMIT) + '...[truncated]'
      : textContent

  return {
    results: [{ title: truncatedTitle, content: truncatedContent, url }],
    query: '',
    images: []
  }
}

export async function fetchRegularData(
  url: string
): Promise<SearchResultsType> {
  try {
    const response = await fetchWithRetry(url)

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/pdf')) {
      // Signal the chain to reroute to the PDF path (see execute below).
      throw new Error(`PDF content type: ${contentType}`)
    }
    if (
      !contentType.includes('text/html') &&
      !contentType.includes('text/plain')
    ) {
      throw new Error(`Unsupported content type: ${contentType}`)
    }

    const html = await response.text()
    return htmlToResults(html, url)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Request timeout after 10 seconds')
    }
    console.error('Fetch error:', error)
    throw error instanceof Error ? error : new Error('Unknown fetch error')
  }
}

// Free tier 2 of the rescue chain: FlareSolverr solves Cloudflare-style
// bot walls with a real headless browser, which also renders JS — so it
// rescues both blocked pages and empty JS shells at zero cost.
async function fetchFlaresolverrData(url: string): Promise<SearchResultsType> {
  const html = await flaresolverrGet(url)
  return htmlToResults(html, url)
}

// Paid tier 3 (last resort): Firecrawl /scrape. 1 credit per call on a
// finite free allowance — every call is logged so burn rate is auditable.
async function fetchFirecrawlData(url: string): Promise<SearchResultsType> {
  const apiKey = process.env.FIRECRAWL_API_KEY
  if (!apiKey) {
    throw new Error('FIRECRAWL_API_KEY is not configured')
  }

  console.log(`[firecrawl] scrape rescue for ${url} (1 credit)`)
  // Bounded: FirecrawlClient owns its own fetch and exposes no timeout, so the
  // deadline is applied here. Last tier of a chain that had no ceiling at all.
  const { markdown, title } = await withDeadline(
    new FirecrawlClient(apiKey).scrape(url),
    FETCH_RESCUE_TIER_TIMEOUT_MS,
    () => {
      throw new Error(
        `Firecrawl scrape exceeded ${FETCH_RESCUE_TIER_TIMEOUT_MS}ms`
      )
    }
  )

  const content =
    markdown.length > CONTENT_CHARACTER_LIMIT
      ? markdown.substring(0, CONTENT_CHARACTER_LIMIT) + '...[truncated]'
      : markdown

  return {
    results: [
      {
        title: (title || new URL(url).hostname).substring(
          0,
          TITLE_CHARACTER_LIMIT
        ),
        content,
        url
      }
    ],
    query: '',
    images: []
  }
}

const PDF_MAX_BYTES = 25 * 1024 * 1024

export function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf')
  } catch {
    return false
  }
}

// Free PDF path: download and extract locally with pdftotext (already in
// the app image for upload handling). Firecrawl is only consulted when
// this fails (e.g. a JS-gated download or an image-only scan).
async function fetchPdfData(url: string): Promise<SearchResultsType> {
  const response = await fetchWithRetry(url)
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.byteLength > PDF_MAX_BYTES) {
    throw new Error(`PDF too large (${buf.byteLength} bytes)`)
  }

  const tmpPath = path.join(
    os.tmpdir(),
    `ask-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`
  )
  try {
    await fs.writeFile(tmpPath, buf)
    const { stdout } = await execFileAsync(
      'pdftotext',
      ['-layout', '-enc', 'UTF-8', tmpPath, '-'],
      { maxBuffer: 10 * 1024 * 1024 }
    )
    const text = stdout.trim()
    if (text.length < MIN_CONTENT_LENGTH) {
      throw new Error('pdftotext extracted no meaningful text')
    }

    const content =
      text.length > CONTENT_CHARACTER_LIMIT
        ? text.substring(0, CONTENT_CHARACTER_LIMIT) + '...[truncated]'
        : text
    const filename = path.basename(new URL(url).pathname) || url

    return {
      results: [
        { title: filename.substring(0, TITLE_CHARACTER_LIMIT), content, url }
      ],
      query: '',
      images: []
    }
  } finally {
    await fs.unlink(tmpPath).catch(() => {})
  }
}

async function fetchJinaReaderData(url: string): Promise<SearchResultsType> {
  try {
    const response = await fetch(`https://r.jina.ai/${url}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-With-Generated-Alt': 'true'
      }
    })
    const json = await response.json()
    if (!json.data || json.data.length === 0) {
      throw new Error('No data returned from Jina Reader API')
    }

    const content = json.data.content.slice(0, CONTENT_CHARACTER_LIMIT)

    return {
      results: [
        {
          title: json.data.title,
          content,
          url: json.data.url
        }
      ],
      query: '',
      images: []
    }
  } catch (error) {
    console.error('API Error:', error)
    throw error instanceof Error ? error : new Error('Jina Reader API failed')
  }
}

async function fetchTavilyExtractData(url: string): Promise<SearchResultsType> {
  try {
    const apiKey = process.env.TAVILY_API_KEY
    // Bounded: this tier had no timeout, and it only runs after three cheaper
    // tiers already failed on this URL.
    const controller = new AbortController()
    const timeoutId = setTimeout(
      () => controller.abort(),
      FETCH_RESCUE_TIER_TIMEOUT_MS
    )
    let response: Response
    try {
      response = await fetch('https://api.tavily.com/extract', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ api_key: apiKey, urls: [url] }),
        signal: controller.signal
      })
    } finally {
      clearTimeout(timeoutId)
    }
    const json = await response.json()
    if (!json.results || json.results.length === 0) {
      throw new Error('No results returned from content extraction service')
    }

    const result = json.results[0]
    const content = result.raw_content.slice(0, CONTENT_CHARACTER_LIMIT)

    return {
      results: [
        {
          title: content.slice(0, TITLE_CHARACTER_LIMIT),
          content,
          url: result.url
        }
      ],
      query: '',
      images: []
    }
  } catch (error) {
    console.error('API Error:', error)
    throw error instanceof Error
      ? error
      : new Error('Content extraction service failed')
  }
}

// Free tier 2 of the rescue chain: the self-hosted Crawl4AI server — a
// real headless browser returning clean markdown. Unmetered, so it sits
// above both FlareSolverr and Firecrawl: it rescues the common failure
// (JS-rendered page that a plain fetch sees as an empty shell) without
// spending anything.
async function fetchCrawl4aiData(url: string): Promise<SearchResultsType> {
  const { markdown, title } = await crawl4aiScrapeOne(url)

  if (markdown.length < MIN_CONTENT_LENGTH) {
    throw new Error(
      `Crawl4AI extracted too little content (${markdown.length} chars)`
    )
  }

  const content =
    markdown.length > CONTENT_CHARACTER_LIMIT
      ? markdown.substring(0, CONTENT_CHARACTER_LIMIT) + '...[truncated]'
      : markdown

  return {
    results: [
      {
        title: (title || new URL(url).hostname).substring(
          0,
          TITLE_CHARACTER_LIMIT
        ),
        content,
        url
      }
    ],
    query: '',
    images: []
  }
}

// Runs the rescue chain for a non-YouTube, non-PDF URL. Tiers are ordered
// by cost: plain fetch (free) → Crawl4AI (free, self-hosted browser +
// markdown) → FlareSolverr (free, self-hosted, specifically for
// Cloudflare-style bot walls Crawl4AI can't clear) → Jina/Tavily extract
// (only when their API key is configured — inert in deployments without
// them) → Firecrawl scrape (1 credit, last resort). Each tier only runs
// when every cheaper tier has failed; if everything fails the last error
// propagates to the graceful placeholder below.
async function fetchWithRescueChain(url: string): Promise<SearchResultsType> {
  let lastError: unknown

  try {
    return await fetchRegularData(url)
  } catch (error) {
    lastError = error
    // A URL without a .pdf extension can still serve a PDF — reroute.
    if (error instanceof Error && error.message.includes('PDF content type')) {
      return fetchPdfWithRescue(url)
    }
  }

  if (isCrawl4aiConfigured()) {
    try {
      return await fetchCrawl4aiData(url)
    } catch (error) {
      lastError = error
      console.error(`[fetch-chain] Crawl4AI failed for ${url}:`, error)
    }
  }

  if (isFlaresolverrConfigured()) {
    try {
      return await fetchFlaresolverrData(url)
    } catch (error) {
      lastError = error
      console.error(`[fetch-chain] FlareSolverr failed for ${url}:`, error)
    }
  }

  if (process.env.JINA_API_KEY) {
    try {
      return await fetchJinaReaderData(url)
    } catch (error) {
      lastError = error
    }
  } else if (process.env.TAVILY_API_KEY) {
    try {
      return await fetchTavilyExtractData(url)
    } catch (error) {
      lastError = error
    }
  }

  if (process.env.FIRECRAWL_API_KEY) {
    try {
      return await fetchFirecrawlData(url)
    } catch (error) {
      lastError = error
      console.error(`[fetch-chain] Firecrawl failed for ${url}:`, error)
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('All fetch tiers failed')
}

// PDF chain: free local extraction first, Firecrawl only as last resort.
async function fetchPdfWithRescue(url: string): Promise<SearchResultsType> {
  try {
    return await fetchPdfData(url)
  } catch (error) {
    console.error(
      `[fetch-chain] local PDF extraction failed for ${url}:`,
      error
    )
    if (process.env.FIRECRAWL_API_KEY) {
      return fetchFirecrawlData(url)
    }
    throw error
  }
}

/**
 * Everything one URL goes through: YouTube transcript, PDF, or the bounded
 * rescue chain. Extracted from the tool's execute() so a batch can run several
 * concurrently — the logic per url is unchanged.
 */
async function fetchOneUrl(url: string): Promise<SearchResultsType> {
  // SSRF guard BEFORE the deadline race, so a blocked internal/private URL
  // fails fast with its real reason ("Blocked outbound request to …: private or
  // reserved IPv4") instead of being masked by withDeadline's generic
  // "exceeded 40000ms" fallback. Its own DNS check is internally bounded
  // (DNS_TIMEOUT_MS), so it cannot itself hang. This is the single point every
  // fetched URL — YouTube, PDF, rescue chain — passes through, and it runs
  // before any request is made or the URL is handed to an external scraper
  // (Firecrawl/Jina). See lib/utils/ssrf-guard.ts.
  await assertUrlAllowed(url)

  // The deadline lives HERE, at the per-url boundary, not inside the regular
  // rescue chain. It was originally on fetchWithRescueChain, which left the
  // YouTube-transcript and PDF branches completely unbounded — a prod turn then
  // spent 56.1s in a single fetch call against a supposed 40s ceiling. Every
  // path a url can take must be covered, not just the common one.
  return withDeadline(routeOneUrl(url), FETCH_TOTAL_DEADLINE_MS, () => {
    // Throwing hands control to the tool's own catch, which yields the
    // graceful "Fetch failed" placeholder. The model then sees a normal failed
    // fetch and moves on, instead of the turn stalling.
    throw new Error(`Fetch exceeded ${FETCH_TOTAL_DEADLINE_MS}ms for ${url}`)
  })
}

async function routeOneUrl(url: string): Promise<SearchResultsType> {
  if (isYoutubeUrl(url)) {
    try {
      return await fetchYoutubeTranscriptData(url)
    } catch (transcriptError) {
      // No captions, transcripts disabled, video unavailable, etc. — fall back
      // to the rescue chain so the model still gets the video page's
      // title/description instead of a failed step.
      console.error(
        'YouTube transcript fetch failed, falling back to page fetch:',
        transcriptError
      )
      return fetchWithRescueChain(url)
    }
  }
  if (isPdfUrl(url)) return fetchPdfWithRescue(url)
  return fetchWithRescueChain(url)
}

export const fetchTool = tool({
  description:
    'Fetch content from any URL — HTML pages, JavaScript-rendered pages, bot-protected pages, and PDFs are all handled automatically via an internal fallback chain, so there is no need to choose a fetch strategy. The "type" param is accepted for backward compatibility but both values behave identically. For YouTube URLs (youtube.com/watch, youtube.com/shorts, youtu.be), the tool fetches the video\'s transcript/captions instead of the HTML page, so the video\'s actual spoken content becomes available to cite.',
  inputSchema: fetchSchema,
  async *execute({ url, type: _type = 'regular' }) {
    const urls = normalizeFetchUrls(url)

    // Yield initial fetching state. `url` echoes the caller's shape so the UI
    // and persisted messages keep working for single-url calls.
    yield {
      state: 'fetching' as const,
      url: urls.length === 1 ? urls[0] : urls
    }

    try {
      if (urls.length === 0) {
        throw new Error('No usable URL was provided')
      }

      // Concurrent, because the point of batching is to pay ONE model round
      // trip instead of N. Bounded because these share the Crawl4AI and
      // FlareSolverr backends with the crawl stage, where unbounded fan-out
      // measured worse than bounded. Each url carries its own 40s deadline,
      // so a batch costs about the slowest page, not the sum.
      const settled = await mapWithConcurrency(urls, FETCH_MAX_URLS, u =>
        fetchOneUrl(u)
      )

      const merged: SearchResultsType = { results: [], query: '', images: [] }
      const failures: string[] = []
      settled.forEach((outcome, i) => {
        if (outcome instanceof Error) {
          // A dead url in a batch must not lose the others' content.
          failures.push(urls[i])
          console.error(`[fetch] failed for ${urls[i]}:`, outcome.message)
          return
        }
        merged.results.push(...outcome.results)
        if (outcome.images?.length) merged.images.push(...outcome.images)
      })

      if (merged.results.length === 0) {
        throw new Error(
          `Fetch failed for all ${urls.length} URL(s): ${failures.join(', ')}`
        )
      }

      logToolPayload('fetch', urls.join(' '), { results: merged.results })

      yield {
        state: 'complete' as const,
        ...merged
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown fetch error'
      console.error('Fetch error:', message)
      // Return a graceful result so the agent can continue rather than crashing the stream
      yield {
        state: 'complete' as const,
        results: [
          {
            title: `Fetch failed: ${url}`,
            content: `Could not retrieve this page (${message}). Skip this URL and continue with other sources.`,
            url
          }
        ],
        query: '',
        images: []
      }
    }
  }
})

// Export type for UI tool invocation
export type FetchUIToolInvocation = UIToolInvocation<typeof fetchTool>
