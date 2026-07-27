import { checkBraveBudget, recordBraveCalls } from '@/lib/search/brave-budget'
import {
  SearchImageItem,
  SearchResults,
  SerperSearchResultItem
} from '@/lib/types'

import { SearchProvider } from './base'

// Brave's API rejects count > 20. The merge client clamps; this provider used
// to pass the model's max_results straight through, so any value above 20 made
// Brave 400 — and because each sub-search swallows its own error, the search
// "succeeded" with zero Brave results and silently degraded to SearXNG only.
const BRAVE_MAX_COUNT = 20

interface BraveWebResult {
  title?: string
  description?: string
  url: string
}

interface BraveVideoResult {
  title?: string
  description?: string
  url?: string
  thumbnail?: {
    src?: string
  }
  video?: {
    duration?: string
  }
  duration?: string
  date?: string
  publisher?: string
}

interface BraveImageResult {
  title?: string
  source?: string
  url?: string
  thumbnail?: {
    src?: string
  }
  properties?: {
    thumbnail?: string
    width?: number
    height?: number
  }
  width?: number
  height?: number
}

export class BraveSearchProvider implements SearchProvider {
  private apiKey: string | undefined

  constructor() {
    this.apiKey = process.env.BRAVE_SEARCH_API_KEY
  }

  private getImageThumbnailUrl(result: BraveImageResult): string {
    return (
      result.thumbnail?.src ?? result.properties?.thumbnail ?? result.url ?? ''
    )
  }

  async search(
    query: string,
    maxResults: number = 10,
    searchDepth?: 'basic' | 'advanced',
    includeDomains?: string[],
    excludeDomains?: string[],
    options?: {
      type?: 'general' | 'optimized'
      content_types?: Array<'web' | 'video' | 'image' | 'news'>
    }
  ): Promise<SearchResults> {
    if (!this.apiKey) {
      throw new Error('Brave Search API key not configured')
    }

    const contentTypes = options?.content_types || ['web']
    const results: SearchResults = {
      results: [],
      images: [],
      videos: [],
      query,
      number_of_results: 0
    }

    // Brave rejects count > 20 (see BRAVE_MAX_COUNT).
    const count = Math.min(maxResults, BRAVE_MAX_COUNT)

    // One API call per content type, so a ['web','video','image'] search costs
    // THREE against the monthly quota. Budget-checked as a block, before any
    // of them fire, so a search cannot straddle the cap.
    const wanted = (['web', 'video', 'image'] as const).filter(t =>
      contentTypes.includes(t)
    )
    if (wanted.length === 0) return results

    const budget = await checkBraveBudget(wanted.length)
    if (!budget.allowed) {
      // Degrade quietly rather than throw: the caller merges Brave with
      // SearXNG (merge-general.ts) and a null Brave half is already handled,
      // so an exhausted quota costs breadth, not the search.
      console.warn(
        `[brave] monthly budget reached (${budget.used}/${budget.budget}), skipping ${wanted.length} call(s)`
      )
      return results
    }

    // Execute searches in parallel for each content type. Each resolves to
    // whether it actually reached the API, so only real calls are billed — a
    // Brave outage must not burn the month's quota.
    const runners: Record<(typeof wanted)[number], () => Promise<boolean>> = {
      web: () => this.searchWeb(query, count, results),
      video: () => this.searchVideos(query, count, results),
      image: () => this.searchImages(query, count, results)
    }
    const settled = await Promise.all(wanted.map(t => runners[t]()))
    await recordBraveCalls(settled.filter(Boolean).length)

    // Update total count
    results.number_of_results = results.results.length

    return results
  }

  private async searchWeb(
    query: string,
    maxResults: number,
    results: SearchResults
  ): Promise<boolean> {
    try {
      const response = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
          query
        )}&count=${maxResults}`,
        {
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': this.apiKey!
          }
        }
      )

      if (!response.ok) {
        // Not billed: a rejected request (429 quota, 400 bad count, 5xx) did
        // not consume a successful call, and `false` keeps it off the counter.
        console.error(
          `Brave web search failed: ${response.status} ${response.statusText}`
        )
        return false
      }

      const data = await response.json()
      results.results = (data.web?.results || [])
        .slice(0, maxResults)
        .map((result: BraveWebResult) => ({
          title: result.title || 'No title',
          description: result.description || 'No description available',
          url: result.url
        }))
      return true
    } catch (error) {
      console.error('Brave web search error:', error)
      return false
    }
  }

  private async searchVideos(
    query: string,
    maxResults: number,
    results: SearchResults
  ): Promise<boolean> {
    try {
      const response = await fetch(
        `https://api.search.brave.com/res/v1/videos/search?q=${encodeURIComponent(
          query
        )}&count=${maxResults}`,
        {
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': this.apiKey!
          }
        }
      )

      if (!response.ok) {
        // Not billed: a rejected request (429 quota, 400 bad count, 5xx) did
        // not consume a successful call, and `false` keeps it off the counter.
        console.error(
          `Brave video search failed: ${response.status} ${response.statusText}`
        )
        return false
      }

      const data = await response.json()

      // Convert to SerperSearchResultItem format for compatibility
      results.videos = (data.results || []).slice(0, maxResults).map(
        (result: BraveVideoResult, index: number) =>
          ({
            title: result.title ?? 'No title',
            link: result.url ?? '',
            snippet: result.description ?? 'No description available',
            imageUrl: result.thumbnail?.src ?? '',
            duration: result.video?.duration ?? result.duration ?? '',
            source: result.publisher ?? '',
            channel: result.publisher ?? '',
            date: result.date ?? '',
            position: index
          }) as SerperSearchResultItem
      )
      return true
    } catch (error) {
      console.error('Brave video search error:', error)
      results.videos = []
      return false
    }
  }

  private async searchImages(
    query: string,
    maxResults: number,
    results: SearchResults
  ): Promise<boolean> {
    try {
      const response = await fetch(
        `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(
          query
        )}&count=${maxResults}`,
        {
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': this.apiKey!
          }
        }
      )

      if (!response.ok) {
        // Not billed: a rejected request (429 quota, 400 bad count, 5xx) did
        // not consume a successful call, and `false` keeps it off the counter.
        console.error(
          `Brave image search failed: ${response.status} ${response.statusText}`
        )
        return false
      }

      const data = await response.json()
      results.images = (data.results || []).slice(0, maxResults).map(
        (result: BraveImageResult) =>
          ({
            title: result.title || 'No title',
            link: result.url || result.source || '',
            thumbnailUrl: this.getImageThumbnailUrl(result)
          }) as SearchImageItem
      )
      return true
    } catch (error) {
      console.error('Brave image search error:', error)
      results.images = []
      return false
    }
  }
}
