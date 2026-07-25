import type { SearXNGResult } from '@/lib/types'
import type { BraveSearchResult } from '@/lib/utils/brave-search-client'

import { normalizeUrl } from './merge-degoog'

/**
 * Merge Brave API results into a SearXNG candidate list for the ADVANCED path.
 *
 * Brave goes FIRST, for the same reason Tavily does: it is block-immune (the
 * query runs on Brave's own infrastructure against a subscribed quota, not
 * scraped from our IP), so its URLs should survive the candidate-pool cap and
 * win a dedup collision against a scraped snippet.
 *
 * Like Tavily and unlike Ollama, Brave returns only snippets, so its URLs are
 * NOT marked prefetched — the advanced route crawls them with Crawl4AI for full
 * content. The snippet is just the placeholder `content` until then. Marking
 * them prefetched would skip the crawl and leave a snippet that fails
 * isQualityContent (>50 words) and disappears from the pool entirely.
 */
export function mergeBraveIntoSearxngResults(
  searxngResults: SearXNGResult[],
  braveResults: BraveSearchResult[],
  maxResults: number
): SearXNGResult[] {
  const seen = new Set<string>()
  const merged: SearXNGResult[] = []
  for (const r of braveResults) {
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
