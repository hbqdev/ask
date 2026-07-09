import {
  SearchResultItem,
  SearchResults,
  SearXNGResponse,
  SearXNGResult,
  SerperSearchResultItem
} from '@/lib/types'

import { BaseSearchProvider } from './base'

export class SearXNGSearchProvider extends BaseSearchProvider {
  async search(
    query: string,
    maxResults: number = 10,
    searchDepth: 'basic' | 'advanced' = 'basic',
    includeDomains: string[] = [],
    excludeDomains: string[] = [],
    options?: {
      searchMode?: 'web' | 'academic'
      content_types?: Array<'web' | 'video' | 'image' | 'news'>
    }
  ): Promise<SearchResults> {
    const apiUrl = process.env.SEARXNG_API_URL
    this.validateApiUrl(apiUrl, 'SEARXNG')

    const isAcademic = options?.searchMode === 'academic'
    const wantsVideo = options?.content_types?.includes('video') ?? false

    try {
      // Construct the URL with query parameters
      const url = new URL(`${apiUrl}/search`)
      url.searchParams.append('q', query)
      url.searchParams.append('format', 'json')

      if (isAcademic) {
        url.searchParams.append('categories', 'science')
        url.searchParams.append(
          'engines',
          'google scholar,arxiv,semantic scholar,pubmed'
        )
        url.searchParams.append('safesearch', '0')
      } else {
        // SearXNG accepts a comma-separated category list in one request and
        // tags each result with its own `category` field, so requesting
        // videos alongside general/images costs nothing extra — no second
        // round-trip needed.
        const categories = wantsVideo
          ? 'general,images,videos'
          : 'general,images'
        url.searchParams.append('categories', categories)

        // Apply search depth settings
        if (searchDepth === 'advanced') {
          url.searchParams.append('time_range', '')
          url.searchParams.append('safesearch', '0')
          url.searchParams.append('engines', 'google,bing,duckduckgo,wikipedia')
        } else {
          url.searchParams.append('time_range', 'year')
          url.searchParams.append('safesearch', '1')
          url.searchParams.append('engines', 'google,bing')
        }
      }

      // Apply domain filters if provided
      if (includeDomains.length > 0) {
        url.searchParams.append('site', includeDomains.join(','))
      }

      // Fetch results from SearXNG
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error(`SearXNG API error (${response.status}):`, errorText)
        throw new Error('Search failed')
      }

      const data: SearXNGResponse = await response.json()

      // Separate general, image, and video results, and limit to maxResults
      const generalResults = data.results
        .filter(result => !result.img_src && result.category !== 'videos')
        .slice(0, maxResults)
      const imageResults = data.results
        .filter(result => result.img_src)
        .slice(0, maxResults)
      const videoResults = wantsVideo
        ? data.results
            .filter(result => result.category === 'videos')
            .slice(0, maxResults)
        : []

      // Format the results to match the expected SearchResults structure
      return {
        results: generalResults.map(
          (result: SearXNGResult): SearchResultItem => ({
            title: result.title,
            url: result.url,
            content: result.content
          })
        ),
        query: data.query,
        images: imageResults
          .map(result => {
            const imgSrc = result.img_src || ''
            return imgSrc.startsWith('http') ? imgSrc : `${apiUrl}${imgSrc}`
          })
          .filter(Boolean),
        videos: videoResults.map(
          (result: SearXNGResult): SerperSearchResultItem => ({
            title: result.title,
            link: result.url,
            snippet: result.content,
            imageUrl: result.thumbnail || '',
            duration: result.length || '',
            source: result.source || result.engine || '',
            channel: result.author || '',
            date: result.publishedDate || '',
            position: 0
          })
        ),
        number_of_results: data.number_of_results
      }
    } catch (error) {
      console.error('SearXNG API error:', error)
      throw error
    }
  }
}
