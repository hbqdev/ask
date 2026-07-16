import {
  DegoogResponse,
  SearchResultImage,
  SearchResultItem,
  SearchResults,
  SearXNGResponse,
  SearXNGResult,
  SerperSearchResultItem
} from '@/lib/types'
import { fetchDegoogJson } from '@/lib/utils/degoog-client'
import {
  fetchOllamaSearch,
  type OllamaSearchResult
} from '@/lib/utils/ollama-search-client'
import { fetchSearxngJson } from '@/lib/utils/searxng-client'

import { intentToCategory, type SearchIntent } from '../intent'

import { BaseSearchProvider, SearchContentType, SearchModeOption } from './base'
import {
  mergeImagesWithDegoog,
  mergeVideosWithDegoog,
  mergeWithDegoogResults,
  toSearchResultImage,
  toSearchResultItem,
  toSerperVideoItem
} from './merge-degoog'
import { mergeOllamaIntoResults } from './merge-ollama'

// degoog returns at most 20 results per call; request enough headroom over
// what we'll actually keep so the post-merge dedup/slice has real results
// to choose from instead of just SearXNG's list padded with nothing.
const DEGOOG_MAX_RESULTS = 20

// Truncate Ollama's full page content to snippet size on the basic path so
// results stay uniform with searxng/degoog snippets.
const OLLAMA_BASIC_SNIPPET_CHARS = 400

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
      // Set when the classifier flagged this turn as recency-sensitive
      // (lib/agents/query-classifier.ts needsRecent) — narrows SearXNG's
      // time_range so fresh pages outrank stale ones.
      time_range?: 'day' | 'week' | 'month' | 'year'
      // Auto-detected intent (query classifier). Additive: appends ONE
      // category on top of general,images in the general branch below.
      // Ignored in the exclusive academic/social branches by design.
      intent?: SearchIntent
      // Per-search Ollama web-search inclusion (set by the search tool).
      // Additive complement — failure is swallowed, never fails the search.
      useOllama?: boolean
      ollamaMaxResults?: number
    }
  ): Promise<SearchResults> {
    this.validateApiUrl(
      process.env.SEARXNG_API_URL ?? process.env.SEARXNG_FALLBACK_API_URL,
      'SEARXNG'
    )

    const isAcademic = options?.searchMode === 'academic'
    const isSocial = options?.searchMode === 'social'
    const wantsVideo = options?.content_types?.includes('video') ?? false
    const wantsNews = options?.content_types?.includes('news') ?? false
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

      const buildUrl = (baseUrl: string) => {
        const url = new URL(`${baseUrl}/search`)
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
          //
          // Auto-detected intent adds ONE more category on top (additive:
          // general baseline always fires). Deduped so an intent category
          // already present via content_types isn't repeated.
          const intentCategory = options?.intent
            ? intentToCategory(options.intent)
            : null
          const categoryList = ['general', 'images', ...extraCategories]
          if (intentCategory && !categoryList.includes(intentCategory)) {
            categoryList.push(intentCategory)
          }
          const categories = categoryList.join(',')
          url.searchParams.append('categories', categories)

          // Apply search depth settings. An explicit time_range from the
          // recency classifier overrides the depth default in both modes.
          if (searchDepth === 'advanced') {
            url.searchParams.append('time_range', options?.time_range ?? '')
            url.searchParams.append('safesearch', '0')
            url.searchParams.append(
              'engines',
              'google,bing,duckduckgo,wikipedia'
            )
          } else {
            url.searchParams.append('time_range', options?.time_range ?? 'year')
            url.searchParams.append('safesearch', '1')
            url.searchParams.append('engines', 'google,bing')
          }
        }

        return url.toString()
      }

      const buildDegoogTypeUrl = (type: string) => (baseUrl: string) => {
        const url = new URL(`${baseUrl}/api/search`)
        url.searchParams.append('q', effectiveQuery)
        url.searchParams.append('type', type)
        url.searchParams.append(
          'max_results',
          String(Math.min(DEGOOG_MAX_RESULTS, maxResults * 2))
        )
        return url.toString()
      }

      const buildDegoogUrl = buildDegoogTypeUrl('web')
      // Images are always requested from degoog, mirroring SearXNG's own
      // always-on 'images' category above. Videos/news are only requested
      // when actually asked for, matching SearXNG's conditional categories
      // — no point paying for a degoog fan-out to video/news engines for a
      // response the caller will discard.
      const buildDegoogImageUrl = buildDegoogTypeUrl('images')
      const buildDegoogVideoUrl = buildDegoogTypeUrl('videos')
      const buildDegoogNewsUrl = buildDegoogTypeUrl('news')

      // Query SearXNG and degoog concurrently so latency stays close to
      // whichever is slower, not the sum of both. degoog is a complement,
      // not a dependency: fetchDegoogJson resolves to `null` when it isn't
      // configured, and a real degoog failure is caught here rather than
      // failing the whole search — SearXNG succeeding alone is exactly
      // today's behavior. The reverse also degrades gracefully: if
      // SearXNG's primary AND fallback are both down but degoog succeeds,
      // we still return degoog's results instead of throwing.
      const [
        searxngSettled,
        degoogWebSettled,
        degoogImageSettled,
        degoogVideoSettled,
        degoogNewsSettled,
        ollamaSettled
      ] = await Promise.allSettled([
        fetchSearxngJson(buildUrl),
        fetchDegoogJson(buildDegoogUrl),
        fetchDegoogJson(buildDegoogImageUrl),
        wantsVideo
          ? fetchDegoogJson(buildDegoogVideoUrl)
          : Promise.resolve(null),
        wantsNews ? fetchDegoogJson(buildDegoogNewsUrl) : Promise.resolve(null),
        options?.useOllama
          ? fetchOllamaSearch(query, options.ollamaMaxResults ?? 5)
          : Promise.resolve(null)
      ])

      const extractDegoogResults = (
        settled: PromiseSettledResult<{ data: unknown } | null>,
        label: string
      ) => {
        if (settled.status === 'rejected') {
          console.warn(
            `[degoog] ${label} search failed, continuing without it:`,
            settled.reason
          )
          return []
        }
        if (!settled.value) return []
        return (settled.value.data as DegoogResponse).results ?? []
      }

      const degoogResults = extractDegoogResults(degoogWebSettled, 'web')
      const degoogImageResults = extractDegoogResults(
        degoogImageSettled,
        'image'
      )
      const degoogVideoResults = wantsVideo
        ? extractDegoogResults(degoogVideoSettled, 'video')
        : []
      const degoogNewsResults = wantsNews
        ? extractDegoogResults(degoogNewsSettled, 'news')
        : []

      const ollamaResults: OllamaSearchResult[] =
        ollamaSettled.status === 'fulfilled' && ollamaSettled.value
          ? ollamaSettled.value
          : []
      if (ollamaSettled.status === 'rejected') {
        console.warn(
          '[ollama] basic web search failed, continuing without it:',
          ollamaSettled.reason
        )
      }

      if (searxngSettled.status === 'rejected') {
        if (
          degoogResults.length === 0 &&
          degoogImageResults.length === 0 &&
          degoogVideoResults.length === 0 &&
          degoogNewsResults.length === 0
        ) {
          // Both failed (or degoog isn't configured/returned nothing) —
          // nothing to degrade to.
          throw searxngSettled.reason
        }
        // SearXNG is down but degoog isn't — return degoog-only results
        // rather than fail the whole search.
        const degoogBaseUrl = process.env.DEGOOG_API_URL ?? ''
        const degoogOnlyResults = [...degoogResults, ...degoogNewsResults]
          .slice(0, maxResults)
          .map(toSearchResultItem)
        return {
          results:
            ollamaResults.length > 0
              ? mergeOllamaIntoResults(
                  degoogOnlyResults,
                  ollamaResults,
                  maxResults,
                  OLLAMA_BASIC_SNIPPET_CHARS
                )
              : degoogOnlyResults,
          query,
          images: degoogImageResults
            .slice(0, maxResults)
            .map(result => toSearchResultImage(result, degoogBaseUrl)),
          videos: degoogVideoResults
            .slice(0, maxResults)
            .map(result => toSerperVideoItem(result, degoogBaseUrl)),
          number_of_results: degoogResults.length
        }
      }

      const { data: rawData, baseUrlUsed } = searxngSettled.value
      const data = rawData as SearXNGResponse

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

      const baseResults = [...generalResults, ...extraLinkResults].map(
        (result: SearXNGResult): SearchResultItem => ({
          title: result.title,
          url: result.url,
          content: result.content
        })
      )

      const baseImages: SearchResultImage[] = imageResults
        .map(result => {
          const imgSrc = result.img_src || ''
          return imgSrc.startsWith('http') ? imgSrc : `${baseUrlUsed}${imgSrc}`
        })
        .filter(Boolean)

      const baseVideos = videoResults.map(
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
      )

      const degoogBaseUrl = process.env.DEGOOG_API_URL ?? ''
      // Web and news degoog results both feed the same plain `results` list
      // (news is just a more specific link result, see LINK_RESULT_CATEGORIES
      // above), so merge them together in one pass.
      const degoogTextResults = [...degoogResults, ...degoogNewsResults]

      // Format the results to match the expected SearchResults structure
      return {
        results: (() => {
          const base =
            degoogTextResults.length > 0
              ? mergeWithDegoogResults(
                  baseResults,
                  degoogTextResults,
                  maxResults
                )
              : baseResults
          return ollamaResults.length > 0
            ? mergeOllamaIntoResults(
                base,
                ollamaResults,
                maxResults,
                OLLAMA_BASIC_SNIPPET_CHARS
              )
            : base
        })(),
        query: data.query,
        images:
          degoogImageResults.length > 0
            ? mergeImagesWithDegoog(
                baseImages,
                degoogImageResults,
                maxResults,
                degoogBaseUrl
              )
            : baseImages,
        videos:
          degoogVideoResults.length > 0
            ? mergeVideosWithDegoog(
                baseVideos,
                degoogVideoResults,
                maxResults,
                degoogBaseUrl
              )
            : baseVideos,
        number_of_results: data.number_of_results
      }
    } catch (error) {
      console.error('SearXNG API error:', error)
      throw error
    }
  }
}
