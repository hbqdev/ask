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
import { fetchSchema } from '@/lib/schema/fetch'
import { SearchResults as SearchResultsType } from '@/lib/types'
import {
  extractReadableContent,
  MIN_CONTENT_LENGTH
} from '@/lib/utils/extract-content'
import {
  flaresolverrGet,
  isFlaresolverrConfigured
} from '@/lib/utils/flaresolverr'
import { retryWithBackoff } from '@/lib/utils/retry'
import { logToolPayload } from '@/lib/utils/usage-logging'

const execFileAsync = promisify(execFile)

const CONTENT_CHARACTER_LIMIT = 50000
const TITLE_CHARACTER_LIMIT = 100

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
    { maxRetries: 2, initialDelayMs: 500 }
  )
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
  const { markdown, title } = await new FirecrawlClient(apiKey).scrape(url)

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
    const response = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ api_key: apiKey, urls: [url] })
    })
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

// Runs the rescue chain for a non-YouTube, non-PDF URL. Tiers are ordered
// by cost: plain fetch (free) → FlareSolverr (free, self-hosted) →
// Jina/Tavily extract (only when their API key is configured — inert in
// deployments without them) → Firecrawl scrape (1 credit, last resort).
// Each tier only runs when every cheaper tier has failed; if everything
// fails the last error propagates to the graceful placeholder below.
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

export const fetchTool = tool({
  description:
    'Fetch content from any URL — HTML pages, JavaScript-rendered pages, bot-protected pages, and PDFs are all handled automatically via an internal fallback chain, so there is no need to choose a fetch strategy. The "type" param is accepted for backward compatibility but both values behave identically. For YouTube URLs (youtube.com/watch, youtube.com/shorts, youtu.be), the tool fetches the video\'s transcript/captions instead of the HTML page, so the video\'s actual spoken content becomes available to cite.',
  inputSchema: fetchSchema,
  async *execute({ url, type: _type = 'regular' }) {
    // Yield initial fetching state
    yield {
      state: 'fetching' as const,
      url
    }

    try {
      let results: SearchResultsType

      if (isYoutubeUrl(url)) {
        try {
          results = await fetchYoutubeTranscriptData(url)
        } catch (transcriptError) {
          // No captions, transcripts disabled, video unavailable, etc. —
          // fall back to the rescue chain so the model still gets the
          // video page's title/description instead of a failed step.
          console.error(
            'YouTube transcript fetch failed, falling back to page fetch:',
            transcriptError
          )
          results = await fetchWithRescueChain(url)
        }
      } else if (isPdfUrl(url)) {
        results = await fetchPdfWithRescue(url)
      } else {
        results = await fetchWithRescueChain(url)
      }

      logToolPayload('fetch', url, { results: results.results })

      yield {
        state: 'complete' as const,
        ...results
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
