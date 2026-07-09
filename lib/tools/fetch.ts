import { tool, UIToolInvocation } from 'ai'
import {
  fetchTranscript,
  toPlainText,
  YoutubeTranscriptNotAvailableLanguageError
} from 'youtube-transcript-plus'

import { fetchSchema } from '@/lib/schema/fetch'
import { SearchResults as SearchResultsType } from '@/lib/types'
import { logToolPayload } from '@/lib/utils/usage-logging'

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

async function fetchRegularData(url: string): Promise<SearchResultsType> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000) // 10 second timeout

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Ask/1.0)',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const contentType = response.headers.get('content-type') || ''
    if (
      !contentType.includes('text/html') &&
      !contentType.includes('text/plain')
    ) {
      throw new Error(`Unsupported content type: ${contentType}`)
    }

    const html = await response.text()

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
    const rawTitle = titleMatch ? titleMatch[1].trim() : new URL(url).hostname
    const title =
      rawTitle.length > TITLE_CHARACTER_LIMIT
        ? rawTitle.substring(0, TITLE_CHARACTER_LIMIT) + '...'
        : rawTitle

    // Process HTML content
    let processedHtml = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove scripts
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // Remove styles

    // Replace img tags with alt text or [IMAGE] markers
    processedHtml = processedHtml
      .replace(/<img[^>]+alt\s*=\s*["']([^"']+)["'][^>]*>/gi, ' [IMAGE: $1] ')
      .replace(/<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi, ' [IMAGE] ')
      .replace(/<img[^>]*>/gi, ' [IMAGE] ')

    // Extract text content
    const textContent = processedHtml
      .replace(/<[^>]*>/g, ' ') // Remove remaining HTML tags
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim()

    // Limit content length
    const truncatedContent =
      textContent.length > CONTENT_CHARACTER_LIMIT
        ? textContent.substring(0, CONTENT_CHARACTER_LIMIT) + '...[truncated]'
        : textContent

    return {
      results: [
        {
          title,
          content: truncatedContent,
          url
        }
      ],
      query: '',
      images: []
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Request timeout after 10 seconds')
    }
    console.error('Fetch error:', error)
    throw error instanceof Error ? error : new Error('Unknown fetch error')
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

export const fetchTool = tool({
  description:
    'Fetch content from any URL. By default uses "regular" type which performs fast, direct HTML fetching without external APIs - ideal for most websites. IMPORTANT: "regular" type does NOT support PDFs and will fail on PDF URLs. Use "api" type when you need: 1) PDF content extraction (required for .pdf URLs), 2) Complex JavaScript-rendered pages, 3) Better markdown formatting, 4) Table extraction. The "api" type requires Jina or Tavily API keys and uses Jina Reader if available, otherwise falls back to Tavily Extract. For YouTube URLs (youtube.com/watch, youtube.com/shorts, youtu.be), this tool automatically fetches the video\'s transcript/captions instead of the HTML page, so the video\'s actual spoken content becomes available to cite - the "type" param is ignored for these URLs.',
  inputSchema: fetchSchema,
  async *execute({ url, type = 'regular' }) {
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
          // fall back to a regular HTML fetch so the model still gets the
          // video page's title/description instead of a failed step.
          console.error(
            'YouTube transcript fetch failed, falling back to regular fetch:',
            transcriptError
          )
          results = await fetchRegularData(url)
        }
      } else if (type === 'regular') {
        results = await fetchRegularData(url)
      } else {
        const useJina = process.env.JINA_API_KEY
        if (useJina) {
          results = await fetchJinaReaderData(url)
        } else {
          results = await fetchTavilyExtractData(url)
        }
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
