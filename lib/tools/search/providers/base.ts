import { SearchResults } from '@/lib/types'

export interface SearchProviderOptions {
  type?: 'general' | 'optimized'
  content_types?: Array<'web' | 'video' | 'image' | 'news'>
  searchMode?: 'web' | 'academic'
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
