import type { SearXNGResult } from '@/lib/types'
import type { TavilySearchResult } from '@/lib/utils/tavily-search-client'

import { normalizeUrl } from './merge-degoog'

/**
 * Merge Tavily results into a SearXNG candidate list for the ADVANCED path.
 *
 * Like Ollama, Tavily's URLs are marked prefetched by the advanced route, so
 * the crawler skips them and Tavily's own relevance-paragraph `content` (set on
 * each merged item below) is what the reranker and model read. Only
 * SearXNG/degoog links (quality tier) reach Crawl4AI.
 *
 * Tavily results go first so its block-immune sources survive the candidate-pool
 * cap, and win the dedup on a URL collision with a SearXNG/degoog snippet.
 * Deduped by normalized URL, capped.
 */
export function mergeTavilyIntoSearxngResults(
  searxngResults: SearXNGResult[],
  tavilyResults: TavilySearchResult[],
  maxResults: number
): SearXNGResult[] {
  const seen = new Set<string>()
  const merged: SearXNGResult[] = []
  for (const r of tavilyResults) {
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
