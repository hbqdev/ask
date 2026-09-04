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
 * Like Tavily and Ollama, Brave's URLs are marked prefetched by the advanced
 * route, so the crawler skips them and Brave's own description `content` (set on
 * each merged item below) feeds the reranker and model directly. A description
 * too thin to clear isQualityContent is dropped rather than crawled — the
 * accepted trade for spending zero crawl time on these block-immune sources.
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
