import {
  FirecrawlImageSearchOptions,
  FirecrawlImageSearchResponse,
  FirecrawlScrapeResponse,
  FirecrawlSearchOptions,
  FirecrawlSearchResponse
} from './types'

export class FirecrawlClient {
  private readonly apiKey: string
  private readonly baseUrl = 'https://api.firecrawl.dev/v2'

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async search(
    options: FirecrawlSearchOptions
  ): Promise<FirecrawlSearchResponse> {
    const body = JSON.stringify({
      query: options.query,
      sources: options.sources || ['web'],
      limit: options.limit || 10,
      location: options.location,
      tbs: options.tbs,
      scrapeOptions: {
        formats: ['markdown'],
        proxy: 'auto',
        blockAds: true
      }
    })
    const response = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: this.getHeaders(),
      body
    })

    return this.handleResponse<FirecrawlSearchResponse>(response)
  }

  async searchImages(
    options: FirecrawlImageSearchOptions
  ): Promise<FirecrawlImageSearchResponse> {
    const body = JSON.stringify({
      query: options.query,
      sources: ['images'],
      limit: options.limit || 8
    })

    const response = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: this.getHeaders(),
      body
    })

    return this.handleResponse<FirecrawlImageSearchResponse>(response)
  }

  async getImagesForQuery(
    query: string,
    maxResults: number = 8
  ): Promise<{ url: string; description: string }[]> {
    try {
      const searchResponse = await this.searchImages({
        query,
        limit: maxResults
      })

      const data = searchResponse.data

      if (!searchResponse.success || !data.images) return []

      return data.images.map(image => ({
        url: image.imageUrl,
        description: image.title ?? ''
      }))
    } catch (error) {
      console.error('Firecrawl image search error:', error)
      return []
    }
  }

  /**
   * Scrape a single URL into clean markdown. Costs 1 Firecrawl credit per
   * call — used only as the last tier of the fetch rescue chain, after
   * the free tiers (plain fetch, FlareSolverr) have failed.
   */
  async scrape(
    url: string,
    options?: { timeoutMs?: number }
  ): Promise<{ markdown: string; title?: string }> {
    const controller = new AbortController()
    const timeoutMs = options?.timeoutMs ?? 30_000
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(`${this.baseUrl}/scrape`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          url,
          formats: ['markdown'],
          onlyMainContent: true,
          proxy: 'auto',
          blockAds: true,
          timeout: timeoutMs
        }),
        signal: controller.signal
      })

      const json = await this.handleResponse<FirecrawlScrapeResponse>(response)
      if (!json.success || !json.data?.markdown) {
        throw new Error('Firecrawl scrape returned no markdown content')
      }

      return {
        markdown: json.data.markdown,
        title: json.data.metadata?.title
      }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`
    }
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(
        `Firecrawl status: ${response.status}, reason error: ${errorText}`
      )
    }
    return response.json()
  }
}
