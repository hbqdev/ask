import type { SearXNGResult } from '@/lib/types'
import type { LangSearchResult } from '@/lib/utils/langsearch-client'

import { normalizeUrl } from './merge-degoog'

/**
 * Merge LangSearch results into a SearXNG candidate list for the ADVANCED path.
 *
 * Handled like Tavily and Brave rather than like Ollama: its URLs are NOT
 * marked prefetched, so Crawl4AI still fetches them. That is a deliberate call
 * about text quality, not an oversight. LangSearch's `summary` is long enough
 * to look like page content (15-18k chars) but arrives lossy — lowercased, with
 * punctuation space-separated, e.g. "logical replication of ddls \n fujitsu
 * aws". That is fine for the snippet gate and the cross-encoder to judge
 * relevance on, and bad as the text an answer gets cited from, where casing
 * carries meaning (identifiers, proper nouns, code).
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
