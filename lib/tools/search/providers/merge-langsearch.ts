import type { SearXNGResult } from '@/lib/types'
import type { LangSearchResult } from '@/lib/utils/langsearch-client'

import { normalizeUrl } from './merge-degoog'

/**
 * Merge LangSearch results into a SearXNG candidate list for the ADVANCED path.
 *
 * Handled like Tavily and Brave: its URLs are marked prefetched by the advanced
 * route, so Crawl4AI skips them and its `summary` content (set on each merged
 * item below) feeds the pool as-is. LangSearch's `summary` is long enough to
 * look like page content (15-18k chars) but arrives lossy — lowercased, with
 * punctuation space-separated, e.g. "logical replication of ddls \n fujitsu
 * aws". We accept that casing loss (identifiers, proper nouns, code) as the
 * trade for spending zero crawl time on these block-immune sources; the snippet
 * gate and cross-encoder still judge relevance on it fine.
 *
 * LangSearch goes first so its block-immune sources survive the candidate-pool
 * cap and win dedup against a SearXNG/degoog snippet for the same URL.
 * Deduped by normalized URL, capped.
 */
export function mergeLangSearchIntoSearxngResults(
  searxngResults: SearXNGResult[],
  langSearchResults: LangSearchResult[],
  maxResults: number
): SearXNGResult[] {
  const seen = new Set<string>()
  const merged: SearXNGResult[] = []
  for (const r of langSearchResults) {
    const key = normalizeUrl(r.url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push({ title: r.title, url: r.url, content: r.content })
  }
  for (const r of searxngResults) {
    const key = normalizeUrl(r.url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(r)
  }
  return merged.slice(0, maxResults)
}
