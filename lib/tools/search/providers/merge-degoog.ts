import type { DegoogResult, SearchResultItem } from '@/lib/types'

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
// both match.
const NICHE_SOURCE_MARKERS = [
  'reddit',
  'hacker news',
  'internet archive',
  'wikimedia commons',
  'nasa',
  'openverse',
  'lemmy'
]

function normalizeUrl(rawUrl: string): string {
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

export function toSearchResultItem(result: DegoogResult): SearchResultItem {
  return {
    title: result.title,
    url: result.url,
    content: result.snippet
  }
}

/**
 * Merges degoog results into an existing SearXNG results list: dedupes by
 * normalized URL, rank-interleaves the two lists (neither source's score is
 * on a comparable scale to invent a unified ranking from), then promotes
 * degoog's niche-source results (Reddit, Hacker News, Internet Archive,
 * Wikimedia Commons, NASA, Openverse, Lemmy) ahead of same-tier mainstream
 * duplicates so they survive truncation to `maxResults` — a strict
 * alternation would otherwise likely bury exactly the results this
 * integration exists to surface, since degoog's own top-K is normally
 * dominated by mainstream engines too.
 */
export function mergeWithDegoogResults(
  searxngResults: SearchResultItem[],
  degoogResults: DegoogResult[],
  maxResults: number
): SearchResultItem[] {
  const seen = new Set<string>()
  const interleaved: { item: SearchResultItem; niche: boolean }[] = []

  const maxLen = Math.max(searxngResults.length, degoogResults.length)
  for (let i = 0; i < maxLen; i++) {
    if (i < searxngResults.length) {
      const item = searxngResults[i]
      const key = normalizeUrl(item.url)
      if (!seen.has(key)) {
        seen.add(key)
        interleaved.push({ item, niche: false })
      }
    }
    if (i < degoogResults.length) {
      const result = degoogResults[i]
      const key = normalizeUrl(result.url)
      if (!seen.has(key)) {
        seen.add(key)
        interleaved.push({
          item: toSearchResultItem(result),
          niche: isNicheResult(result)
        })
      }
    }
  }

  // Stable partition: niche results first (in their interleaved order),
  // then everything else (in its interleaved order).
  const niche = interleaved.filter(r => r.niche)
  const rest = interleaved.filter(r => !r.niche)

  return [...niche, ...rest].slice(0, maxResults).map(r => r.item)
}
