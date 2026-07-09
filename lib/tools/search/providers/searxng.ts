import {
  SearchResultItem,
  SearchResults,
  SearXNGResponse,
  SearXNGResult,
  SerperSearchResultItem
} from '@/lib/types'

import { BaseSearchProvider, SearchContentType, SearchModeOption } from './base'

// Maps a content_type to the SearXNG category it requests. 'web' has no
// dedicated category of its own — it's covered by the always-included
// 'general' category. Every other content_type maps 1:1 to a real,
// verified-live SearXNG category (see lib/tools/search/providers/base.ts
// for the full type). 'image' is intentionally absent here: images are
// always requested (see `general,images` below) regardless of
// content_types, matching the pre-existing default behavior.
const CONTENT_TYPE_TO_CATEGORY: Partial<Record<SearchContentType, string>> = {
  video: 'videos',
  news: 'news',
  it: 'it',
  map: 'map',
  music: 'music'
}

// Result categories that should be merged into the plain `results` array
// (link + title + snippet) rather than surfaced through a dedicated typed
// field like `images`/`videos`. These aren't visually distinct media, just
// more specific link results.
const LINK_RESULT_CATEGORIES = new Set(['news', 'it', 'map', 'music'])

export class SearXNGSearchProvider extends BaseSearchProvider {
  async search(
    query: string,
    maxResults: number = 10,
    searchDepth: 'basic' | 'advanced' = 'basic',
    includeDomains: string[] = [],
    excludeDomains: string[] = [],
    options?: {
      searchMode?: SearchModeOption
      content_types?: SearchContentType[]
    }
  ): Promise<SearchResults> {
    const apiUrl = process.env.SEARXNG_API_URL
    this.validateApiUrl(apiUrl, 'SEARXNG')

    const isAcademic = options?.searchMode === 'academic'
    const isSocial = options?.searchMode === 'social'
    const wantsVideo = options?.content_types?.includes('video') ?? false
    const extraCategories = (options?.content_types ?? [])
      .map(ct => CONTENT_TYPE_TO_CATEGORY[ct])
      .filter((cat): cat is string => Boolean(cat))

    try {
      // Construct the URL with query parameters.
      // SearXNG doesn't have a real per-domain filter param (no `site=`) —
      // some underlying engines (Google/Bing) honor a `site:domain.com`
      // operator embedded directly in `q`, but it's unreliable (observed
      // to intermittently return 0 results for the exact same query on
      // retry, likely upstream engine throttling) and doesn't support
      // multiple ORed domains. Use it as a best-effort single-domain hint
      // only; don't rely on it for correctness.
      let effectiveQuery = query
      if (includeDomains.length === 1) {
        effectiveQuery += ` site:${includeDomains[0]}`
      }
      for (const domain of excludeDomains) {
        effectiveQuery += ` -site:${domain}`
      }

      const url = new URL(`${apiUrl}/search`)
      url.searchParams.append('q', effectiveQuery)
      url.searchParams.append('format', 'json')

      if (isAcademic) {
        // SearXNG's own 'science' category already includes arxiv, google
        // scholar, pubmed, semantic scholar, crossref, openalex, and more —
        // broader than and inclusive of the old hardcoded engine list, so
        // there's no need to pin `engines` here.
        url.searchParams.append('categories', 'science')
        url.searchParams.append('safesearch', '0')
      } else if (isSocial) {
        // SearXNG's own 'social media' category covers Reddit, Lemmy,
        // Mastodon, Hacker News, 9gag, and boardreader — broader than the
        // old reddit.com-only domain-filter hack (which never worked
        // anyway, see the include_domains comment above).
        url.searchParams.append('categories', 'social media')
        url.searchParams.append('safesearch', '0')
      } else {
        // SearXNG accepts a comma-separated category list in one request
        // and tags each result with its own `category` field, so
        // requesting videos/news/it/map/music alongside general/images
        // costs nothing extra — no second round-trip needed.
        const categories = ['general', 'images', ...extraCategories].join(',')
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

      // Separate results into: images (has img_src), videos (dedicated
      // `videos` field, only when requested), link-style extra categories
      // (news/it/map/music — merged into `results`), and everything else
      // (general/science/social media all land here too).
      const imageResults = data.results
        .filter(result => result.img_src)
        .slice(0, maxResults)
      const videoResults = wantsVideo
        ? data.results
            .filter(result => result.category === 'videos')
            .slice(0, maxResults)
        : []
      const generalResults = data.results
        .filter(
          result =>
            !result.img_src &&
            result.category !== 'videos' &&
            !(result.category && LINK_RESULT_CATEGORIES.has(result.category))
        )
        .slice(0, maxResults)
      const extraLinkResults = data.results
        .filter(
          result =>
            result.category && LINK_RESULT_CATEGORIES.has(result.category)
        )
        .slice(0, maxResults)

      // Format the results to match the expected SearchResults structure
      return {
        results: [...generalResults, ...extraLinkResults].map(
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
