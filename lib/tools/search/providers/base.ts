import { SearchResults } from '@/lib/types'

export type SearchContentType =
  | 'web'
  | 'video'
  | 'image'
  | 'news'
  | 'it'
  | 'map'
  | 'music'

export type SearchModeOption = 'web' | 'academic' | 'social'

export interface SearchProviderOptions {
  type?: 'general' | 'optimized'
  content_types?: SearchContentType[]
  searchMode?: SearchModeOption
  // Per-turn recency preference from the query classifier (needsRecent).
  // Currently honored by the SearXNG provider.
  time_range?: 'day' | 'week' | 'month' | 'year'
}

export interface SearchProvider {
  search(
    query: string,
    maxResults: number,
    searchDepth: 'basic' | 'advanced',
    includeDomains: string[],
    excludeDomains: string[],
    options?: SearchProviderOptions
  ): Promise<SearchResults>
}

export abstract class BaseSearchProvider implements SearchProvider {
  abstract search(
    query: string,
    maxResults: number,
    searchDepth: 'basic' | 'advanced',
    includeDomains: string[],
    excludeDomains: string[],
    options?: SearchProviderOptions
  ): Promise<SearchResults>

  protected validateApiKey(
    key: string | undefined,
    providerName: string
  ): asserts key is string {
    if (!key) {
      throw new Error(
        `${providerName}_API_KEY is not set in the environment variables`
      )
    }
  }

  protected validateApiUrl(
    url: string | undefined,
    providerName: string
  ): void {
    if (!url) {
      throw new Error(
        `${providerName}_API_URL is not set in the environment variables`
      )
    }
  }
}
