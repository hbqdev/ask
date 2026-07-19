import type {
  DegoogResult,
  SearchResultImage,
  SearchResultItem,
  SearXNGResult,
  SerperSearchResultItem
} from '@/lib/types'

// Tracking params common enough across engines/sites to strip before
// dedup-comparing two URLs. Deliberately NOT stripping the whole query
// string — plenty of legitimately distinct pages differ only by a real
// param (?v=, ?id=, ?title=, etc.), and collapsing those would silently
// drop one of them instead of just deduping true repeats.
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'igshid'
])

// Engine names (as they appear in degoog's `source`/`sources` fields) that
// this integration specifically exists to surface — see the plan's
// motivation (70% niche sources, 30% redundancy). Matched case-insensitively
// as substrings so e.g. "Internet Archive" and "internet-archive-engine"
// both match. Reddit/Hacker News/Internet Archive/Lemmy are web-type
// engines (promoted by mergeWithDegoogResults); Wikimedia Commons/NASA/
// Openverse are image-type engines (promoted by mergeImagesWithDegoog).
const NICHE_SOURCE_MARKERS = [
  'reddit',
  'hacker news',
  'internet archive',
  'wikimedia commons',
  'nasa',
  'openverse',
  'lemmy'
]

export function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    const params = Array.from(url.searchParams.entries())
      .filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b))
    const query = params.length
      ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&')
      : ''

    return `${host}${path}${query}`
  } catch {
    return rawUrl.trim().toLowerCase()
  }
}

function isNicheResult(result: DegoogResult): boolean {
  const haystack = [result.source, ...(result.sources ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return NICHE_SOURCE_MARKERS.some(marker => haystack.includes(marker))
}

// degoog's own thumbnail/imageUrl fields are paths on the degoog instance
// itself (e.g. `/api/proxy/image?url=...&sig=...`), not absolute URLs — they
// only resolve correctly against degoog's own origin, not ask's.
export function resolveDegoogUrl(path: string, baseUrl: string): string {
  if (!path) return path
  if (/^https?:\/\//i.test(path)) return path
  try {
    return new URL(path, baseUrl).toString()
  } catch {
    return path
  }
}

export function toSearchResultItem(result: DegoogResult): SearchResultItem {
  return {
    title: result.title,
    url: result.url,
    content: result.snippet
  }
}

export function toSearchResultImage(
  result: DegoogResult,
  baseUrl: string
): SearchResultImage {
  return {
    url: resolveDegoogUrl(result.imageUrl || result.thumbnail || '', baseUrl),
    description: result.snippet || result.title,
    title: result.title,
    sourceUrl: result.url
  }
}

export function toSerperVideoItem(
  result: DegoogResult,
  baseUrl: string
): SerperSearchResultItem {
  return {
    title: result.title,
    link: result.url,
    snippet: result.snippet,
    imageUrl: resolveDegoogUrl(result.thumbnail || '', baseUrl),
    duration: result.duration || '',
    source: result.source || '',
    channel: '',
    date: '',
    position: 0
  }
}

/**
 * Rank-interleaves an existing (SearXNG) results list with degoog's,
 * dedupes by a caller-supplied key, then promotes degoog's niche-source
 * results (see NICHE_SOURCE_MARKERS) ahead of same-tier mainstream
 * duplicates so they survive truncation to `maxResults` — a strict
 * alternation would otherwise likely bury exactly the results this
 * integration exists to surface, since degoog's own top-K is normally
 * dominated by mainstream engines too. Neither source's `score` is on a
 * comparable scale to invent a unified ranking from, hence interleaving
 * rather than sorting by score.
 */
function interleaveAndDedupe<T>(
  primaryItems: T[],
  degoogResults: DegoogResult[],
  maxResults: number,
  toItem: (result: DegoogResult) => T,
  getKey: (item: T) => string
): T[] {
  const seen = new Set<string>()
  const interleaved: { item: T; niche: boolean }[] = []

  const maxLen = Math.max(primaryItems.length, degoogResults.length)
  for (let i = 0; i < maxLen; i++) {
    if (i < primaryItems.length) {
      const item = primaryItems[i]
      const key = getKey(item)
      if (key && !seen.has(key)) {
        seen.add(key)
        interleaved.push({ item, niche: false })
      }
    }
    if (i < degoogResults.length) {
      const result = degoogResults[i]
      const item = toItem(result)
      const key = getKey(item)
      if (key && !seen.has(key)) {
        seen.add(key)
        interleaved.push({ item, niche: isNicheResult(result) })
      }
    }
  }

  // Stable partition: niche results first (in their interleaved order),
  // then everything else (in its interleaved order).
  const niche = interleaved.filter(r => r.niche)
  const rest = interleaved.filter(r => !r.niche)

  return [...niche, ...rest].slice(0, maxResults).map(r => r.item)
}

export function mergeWithDegoogResults(
  searxngResults: SearchResultItem[],
  degoogResults: DegoogResult[],
  maxResults: number
): SearchResultItem[] {
  return interleaveAndDedupe(
    searxngResults,
    degoogResults,
    maxResults,
    toSearchResultItem,
    item => normalizeUrl(item.url)
  )
}

export function mergeImagesWithDegoog(
  searxngImages: SearchResultImage[],
  degoogResults: DegoogResult[],
  maxResults: number,
  baseUrl: string
): SearchResultImage[] {
  return interleaveAndDedupe(
    searxngImages,
    degoogResults,
    maxResults,
    result => toSearchResultImage(result, baseUrl),
    image => (typeof image === 'string' ? image : image.url)
  )
}

/**
 * Merge degoog WEB results into a SearXNG result list as additional
 * crawl+rerank candidates for the advanced search path. degoog results are
 * converted to the SearXNGResult shape (snippet -> content) and interleaved/
 * deduped by normalized URL, with niche sources promoted so they survive the
 * candidate-pool truncation. Gives the advanced (first, deepest) search the
 * same SearXNG+degoog source union the basic path already has.
 */
export function mergeDegoogIntoSearxngResults(
  searxngResults: SearXNGResult[],
  degoogResults: DegoogResult[],
  maxResults: number
): SearXNGResult[] {
  return interleaveAndDedupe(
    searxngResults,
    degoogResults,
    maxResults,
    (result): SearXNGResult => ({
      title: result.title,
      url: result.url,
      content: result.snippet
    }),
    item => normalizeUrl(item.url)
  )
}

export function mergeVideosWithDegoog(
  searxngVideos: SerperSearchResultItem[],
  degoogResults: DegoogResult[],
  maxResults: number,
  baseUrl: string
): SerperSearchResultItem[] {
  return interleaveAndDedupe(
    searxngVideos,
    degoogResults,
    maxResults,
    result => toSerperVideoItem(result, baseUrl),
    item => normalizeUrl(item.link)
  )
}
