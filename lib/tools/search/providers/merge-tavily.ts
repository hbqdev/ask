import type { SearXNGResult } from '@/lib/types'
import type { TavilySearchResult } from '@/lib/utils/tavily-search-client'

import { normalizeUrl } from './merge-degoog'

/**
 * Merge Tavily results into a SearXNG candidate list for the ADVANCED path.
 *
 * Unlike Ollama (which carries FULL page content and is therefore marked
 * prefetched so the crawler skips it), Tavily returns only snippets — so its
 * URLs are NOT marked prefetched: the advanced route crawls them with Crawl4AI
 * for full content, exactly like SearXNG/degoog results. Tavily's snippet is
 * the placeholder `content` until the crawl fills it in.
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
