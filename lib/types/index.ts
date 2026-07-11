// Re-export SearchMode for convenience
export type { SearchMode } from './search'

export type SearchResults = {
  images: SearchResultImage[]
  results: SearchResultItem[]
  videos?: SerperSearchResultItem[]
  number_of_results?: number
  query: string
  toolCallId?: string // ID of the search tool call
  citationMap?: Record<number, SearchResultItem> // Maps citation number to search result
}

// If include_images_description is true, images are objects with url/description.
// When the provider can resolve the referring page, sourceUrl and title are also set.
// Otherwise, the images are an array of strings.
export type SearchResultImage =
  | string
  | {
      url: string
      description: string
      title?: string
      sourceUrl?: string
      number_of_results?: number
    }

export type ExaSearchResults = {
  results: ExaSearchResultItem[]
}

export type SerperSearchResults = {
  searchParameters: {
    q: string
    type: string
    engine: string
  }
  videos: SerperSearchResultItem[]
}

export type SearchResultItem = {
  title: string
  url: string
  content: string
}

export type ExaSearchResultItem = {
  score: number
  title: string
  id: string
  url: string
  publishedDate: Date
  author: string
}

export type SerperSearchResultItem = {
  title: string
  link: string
  snippet: string
  imageUrl: string
  duration: string
  source: string
  channel: string
  date: string
  position: number
}

export type SearchImageItem = {
  title: string
  link: string
  thumbnailUrl: string
}

export interface SearXNGResult {
  title: string
  url: string
  content: string
  img_src?: string
  publishedDate?: string
  score?: number
  // Video-category fields (present when categories includes "videos")
  category?: string
  thumbnail?: string
  length?: string
  source?: string
  engine?: string
  author?: string
}

export interface SearXNGResponse {
  query: string
  number_of_results: number
  results: SearXNGResult[]
}

export type SearXNGImageResult = string

export type SearXNGSearchResults = {
  images: SearXNGImageResult[]
  results: SearchResultItem[]
  number_of_results?: number
  query: string
}

// degoog is a complementary metasearch aggregator merged into the SearXNG
// provider's results (see lib/tools/search/providers/searxng.ts) — it
// already merges/dedupes across its own configured engines and annotates
// each result with which of them agreed on it. `thumbnail`/`imageUrl` are
// paths on the degoog instance itself (e.g. `/api/proxy/image?...`) and
// must be resolved to an absolute URL against the degoog base URL before
// use — see resolveDegoogUrl in merge-degoog.ts.
export interface DegoogResult {
  title: string
  url: string
  snippet: string
  source?: string
  score?: number
  sources?: string[]
  thumbnail?: string
  imageUrl?: string
  duration?: string
  insecure?: boolean
  isGif?: boolean
}

export interface DegoogResponse {
  query: string
  results: DegoogResult[]
}

export type UploadedFile = {
  file?: File
  status: 'uploading' | 'uploaded' | 'error'
  url?: string
  name?: string
  key?: string
  mediaType?: string
  libraryFileId?: string
}
