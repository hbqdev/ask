/**
 * Search provider configuration utilities
 * Provides environment-aware descriptions and guidance for search tools
 */

/**
 * Checks if a dedicated "general" search provider is available.
 * Brave Search supports it directly; SearXNG supports it too via its
 * `categories` param (general,images,videos in one request) — see
 * SearXNGSearchProvider.search(). Tavily/Exa/Firecrawl don't.
 */
export function isGeneralSearchProviderAvailable(): boolean {
  return !!process.env.BRAVE_SEARCH_API_KEY || !!process.env.SEARXNG_API_URL
}

/**
 * Gets the name of the current general search provider
 */
export function getGeneralSearchProviderName(): string {
  if (process.env.BRAVE_SEARCH_API_KEY) {
    return 'Brave Search'
  }
  if (process.env.SEARXNG_API_URL) {
    return 'SearXNG'
  }
  return 'primary provider'
}

/**
 * Checks if the general search provider supports multimedia content types
 */
export function supportsMultimediaContentTypes(): boolean {
  // Brave and SearXNG both support video/image content_types
  return !!process.env.BRAVE_SEARCH_API_KEY || !!process.env.SEARXNG_API_URL
}

/**
 * Gets the appropriate search type description based on available providers
 */
export function getSearchTypeDescription(): string {
  const hasGeneralProvider = isGeneralSearchProviderAvailable()
  const providerName = getGeneralSearchProviderName()

  if (hasGeneralProvider) {
    return `Search type: general for ${providerName} (supports video/image with content_types, basic results may need fetch for details), optimized for AI-focused providers with content snippets (Tavily/Exa/SearXNG)`
  } else {
    return 'Search type: general and optimized both use the primary AI-focused provider (Tavily/Exa/SearXNG) with content snippets. Note: video/image content_types require a dedicated general search provider (not configured)'
  }
}

/**
 * Gets the tool description based on available providers
 */
export function getSearchToolDescription(): string {
  const supportsMultimedia = supportsMultimediaContentTypes()

  if (supportsMultimedia) {
    return 'Search the web for information. For YouTube/video content, use type="general" with content_types:["video"] for optimal visual presentation with thumbnails.'
  } else {
    return 'Search the web for information using AI-focused providers. Note: Video/image searches with content_types require a dedicated general search provider (not configured). Use type="optimized" for best results with available providers.'
  }
}

/**
 * Gets content types guidance for agent prompts
 */
export function getContentTypesGuidance(): string {
  const hasGeneralProvider = isGeneralSearchProviderAvailable()
  const providerName = getGeneralSearchProviderName()
  const supportsMultimedia = supportsMultimediaContentTypes()

  if (hasGeneralProvider && supportsMultimedia) {
    return `- **type="general" (for time-sensitive or specific content):**
  - Uses ${providerName} for enhanced multimedia support
  - Returns search results without deep content extraction
  - Best for:
    - Today's news, current events, recent updates: content_types: ['news']
    - Videos: content_types: ['video'] or ['web', 'video']
    - Images: content_types: ['image'] or ['web', 'image']
    - Programming/software/library/package questions: content_types: ['it'] (searches GitHub, StackOverflow, npm, PyPI, MDN)
    - Location/place questions ("where is X"): content_types: ['map']
    - Song/artist/album questions: content_types: ['music']
    - When you need the LATEST information where recency matters
  - Pattern: type="general" search → identify sources → fetch for content`
  } else {
    return `- **type="general" and type="optimized":**
  - Both use the primary AI-focused provider (Tavily/Exa/SearXNG)
  - Returns search results with content snippets
  - Note: Video/image content_types are not supported (requires dedicated general search provider)
  - Best for: Research questions, fact-finding, explanatory queries
  - Use type="optimized" for consistent behavior`
  }
}

/**
 * Gets the search strategy guidance for planning mode
 */
export function getSearchStrategyGuidance(): string {
  const hasGeneralProvider = isGeneralSearchProviderAvailable()
  const supportsMultimedia = supportsMultimediaContentTypes()

  if (hasGeneralProvider && supportsMultimedia) {
    return `Search strategy:
- Use type="optimized" for most research queries (provides content snippets)
- Use type="general" for time-sensitive info, videos, or images (requires fetch)
- ALWAYS follow type="general" searches with fetch tool for content
- For comprehensive research: multiple searches + selective fetching`
  } else {
    return `Search strategy:
- Use type="optimized" for all queries (provides content snippets from primary provider)
- type="general" will behave the same as "optimized" (dedicated general search provider not available)
- Fetch tool can be used optionally for deeper content analysis
- For comprehensive research: multiple searches + selective fetching`
  }
}

/**
 * Gets the appropriate search provider type for "general" searches.
 * Prefers Brave when configured, falls back to SearXNG (also multimedia-
 * capable), otherwise null to indicate the caller should fall back to the
 * primary optimized-search provider.
 */
export function getGeneralSearchProviderType(): 'brave' | 'searxng' | null {
  if (process.env.BRAVE_SEARCH_API_KEY) {
    return 'brave'
  }
  if (process.env.SEARXNG_API_URL) {
    return 'searxng'
  }
  return null
}
