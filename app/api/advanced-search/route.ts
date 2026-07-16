import { NextResponse } from 'next/server'

import { Redis } from '@upstash/redis'
import http from 'http'
import { Agent } from 'http'
import https from 'https'
import { JSDOM, VirtualConsole } from 'jsdom'
import { createClient } from 'redis'

import {
  rerankByCrossEncoder,
  rerankByEmbedding
} from '@/lib/embeddings/rerank'
import { intentToCategory, type SearchIntent } from '@/lib/tools/search/intent'
import {
  mergeDegoogIntoSearxngResults,
  resolveDegoogUrl
} from '@/lib/tools/search/providers/merge-degoog'
import { mergeOllamaIntoSearxngResults } from '@/lib/tools/search/providers/merge-ollama'
import {
  DegoogResponse,
  SearchResultItem,
  SearXNGResponse,
  SearXNGResult,
  SearXNGSearchResults
} from '@/lib/types'
import { crawl4aiScrapeMany, isCrawl4aiConfigured } from '@/lib/utils/crawl4ai'
import { isCrossEncoderConfigured } from '@/lib/utils/cross-encoder'
import { fetchDegoogJson } from '@/lib/utils/degoog-client'
import {
  extractReadableContent,
  MIN_CONTENT_LENGTH
} from '@/lib/utils/extract-content'
import {
  fetchOllamaSearch,
  type OllamaSearchResult
} from '@/lib/utils/ollama-search-client'
import { fetchSearxngJson } from '@/lib/utils/searxng-client'

/**
 * Maximum number of results to fetch from SearXNG.
 * Increasing this value can improve result quality but may impact performance.
 * In advanced search mode, this is multiplied by SEARXNG_CRAWL_MULTIPLIER for initial fetching.
 */
const SEARXNG_MAX_RESULTS = Math.max(
  10,
  Math.min(100, parseInt(process.env.SEARXNG_MAX_RESULTS || '50', 10))
)

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

export async function POST(request: Request) {
  const {
    query,
    maxResults,
    searchDepth,
    includeDomains,
    excludeDomains,
    timeRange,
    intent,
    useOllama,
    ollamaMaxResults
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

    // Try to get cached results
    const cachedResults = await getCachedResults(cacheKey)
    if (cachedResults) {
      return NextResponse.json(cachedResults)
    }

    // If not cached, perform the search
    const results = await advancedSearchXNGSearch(
      query,
      Math.min(maxResults, SEARXNG_MAX_RESULTS),
      searchDepth || SEARXNG_DEFAULT_DEPTH,
      Array.isArray(includeDomains) ? includeDomains : [],
      Array.isArray(excludeDomains) ? excludeDomains : [],
      effectiveTimeRange,
      typeof intent === 'string' ? (intent as SearchIntent) : 'general',
      Boolean(useOllama),
      typeof ollamaMaxResults === 'number' ? ollamaMaxResults : 5
    )

    // Cache the results
    await setCachedResults(cacheKey, results)

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
  ollamaMaxResults = 5
): Promise<SearXNGSearchResults> {
  if (!process.env.SEARXNG_API_URL && !process.env.SEARXNG_FALLBACK_API_URL) {
    throw new Error('SEARXNG_API_URL is not set in the environment variables')
  }

  const SEARXNG_ENGINES =
    process.env.SEARXNG_ENGINES || 'google,bing,duckduckgo,wikipedia'
  const SEARXNG_TIME_RANGE = process.env.SEARXNG_TIME_RANGE || 'None'
  const SEARXNG_SAFESEARCH = process.env.SEARXNG_SAFESEARCH || '0'
  const SEARXNG_CRAWL_MULTIPLIER = parseInt(
    process.env.SEARXNG_CRAWL_MULTIPLIER || '4',
    10
  )

  try {
    const resultsPerPage = 10
    const pageno = Math.ceil(maxResults / resultsPerPage)

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
      ollamaSettled
    ] = await Promise.allSettled([
      fetchSearxngJson(buildUrl),
      fetchDegoogJson(degoogUrl('web')),
      intent === 'news'
        ? fetchDegoogJson(degoogUrl('news'))
        : Promise.resolve(null),
      fetchDegoogJson(degoogUrl('images')),
      useOllama
        ? fetchOllamaSearch(query, ollamaMaxResults)
        : Promise.resolve(null)
    ])

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
    const prefetchedUrls = new Set(ollamaResults.map(r => r.url))

    const data = rawData as SearXNGResponse

    if (!data || !Array.isArray(data.results)) {
      console.error('Invalid response structure from SearXNG:', data)
      throw new Error('Invalid response structure from SearXNG')
    }

    let generalResults = data.results.filter(
      (result: SearXNGResult) => result && !result.img_src
    )

    // Apply domain filtering manually
    if (includeDomains.length > 0 || excludeDomains.length > 0) {
      generalResults = generalResults.filter(result => {
        const domain = new URL(result.url).hostname
        return (
          (includeDomains.length === 0 ||
            includeDomains.some(d => domain.includes(d))) &&
          (excludeDomains.length === 0 ||
            !excludeDomains.some(d => domain.includes(d)))
        )
      })
    }

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

    if (searchDepth === 'advanced') {
      const candidates = generalResults.slice(
        0,
        maxResults * SEARXNG_CRAWL_MULTIPLIER
      )

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
      const MAX_ENRICH_URLS = 16
      const toEnrich = candidates
        .filter(r => !prefetchedUrls.has(r.url))
        .slice(0, MAX_ENRICH_URLS)
      const beyondCap = candidates.length - toEnrich.length

      // Chunked + never-throws, so a slow chunk degrades to "those URLs
      // weren't enriched" instead of aborting the whole enrichment (an
      // earlier all-or-nothing version turned one timeout into a 140s
      // turn by re-crawling every candidate through the legacy path).
      const scraped = await crawl4aiScrapeMany(
        toEnrich.map(r => r.url),
        // domcontentloaded, not networkidle: benchmarked 4.7s vs 26.4s on
        // a 16-URL batch, with MORE usable results. See Crawl4aiWaitUntil.
        { waitUntil: 'domcontentloaded', chunkSize: 8, chunkTimeoutMs: 60_000 }
      )
      const byUrl = new Map(scraped.map(s => [s.url, s]))

      const crawledResults = await Promise.all(
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
          if (!hit) return crawlPage(result, query)
          return {
            ...result,
            content: highlightQueryTerms(
              `${result.title}\n\n${hit.markdown}`.substring(0, 10000),
              query
            )
          }
        })
      )

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

      const applyReranked = (
        reranked: { doc: { original: SearXNGResult }; score: number }[],
        minScore: number
      ) => {
        generalResults = reranked
          .filter(r => r.score >= minScore)
          .map(r => r.doc.original)
      }

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
        } catch (error) {
          console.error(
            '[advanced-search] embedding rerank failed, using keyword scorer:',
            error
          )
          const MIN_RELEVANCE_SCORE = 10
          generalResults = generalResults
            .map(result => ({
              ...result,
              score: calculateRelevanceScore(result, query)
            }))
            .filter(result => result.score >= MIN_RELEVANCE_SCORE)
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults)
        }
      }
    }

    generalResults = generalResults.slice(0, maxResults)

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
  query: string
): Promise<SearXNGResult> {
  try {
    const html = await fetchHtmlWithTimeout(result.url, 20000)

    // Readability first — cleaner article extraction than the manual DOM
    // walk below (which stays as the fallback for pages where Readability
    // finds no article node).
    const readable = extractReadableContent(html, result.url)
    if (readable && readable.text.length >= MIN_CONTENT_LENGTH) {
      const combined = [result.title, readable.title, readable.text]
        .filter(Boolean)
        .join('\n\n')
        .substring(0, 10000)
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

    const dom = new JSDOM(html, {
      runScripts: 'outside-only',
      resources: 'usable',
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
      let data = ''
      res.on('data', chunk => {
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

function isQualityContent(text: string): boolean {
  const words = text.split(/\s+/).length
  const sentences = text.split(/[.!?]+/).length
  const avgWordsPerSentence = words / sentences

  return (
    words > 50 &&
    sentences > 3 &&
    avgWordsPerSentence > 5 &&
    avgWordsPerSentence < 30 &&
    !text.includes('Content unavailable due to crawling error') &&
    !text.includes('Error fetching content:')
  )
}
