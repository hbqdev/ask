import { SearchResults } from '@/lib/types'

import type { SearchIntent } from '../intent'

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
  // Auto-detected intent (query classifier). Currently honored by the
  // SearXNG provider (basic path); additive on top of the general baseline.
  intent?: SearchIntent
  // Per-search Ollama web-search inclusion (set by the search tool). When true,
  // the provider also queries Ollama's hosted web search and merges its results
  // (snippet-truncated on the basic path). Additive complement — failure is
  // swallowed, never fails the search.
  useOllama?: boolean
  ollamaMaxResults?: number
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
