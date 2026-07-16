import type { SearchResultItem, SearXNGResult } from '@/lib/types'
import type { OllamaSearchResult } from '@/lib/utils/ollama-search-client'

import { normalizeUrl } from './merge-degoog'

/**
 * Merge Ollama results into a SearXNG result list as additional crawl+rerank
 * candidates for the ADVANCED path — carrying their FULL content (the advanced
 * route skips Crawl4AI for these URLs, so this content is what the reranker and
 * model see). Deduped by normalized URL against the existing list, capped.
 */
export function mergeOllamaIntoSearxngResults(
  searxngResults: SearXNGResult[],
  ollamaResults: OllamaSearchResult[],
  maxResults: number
): SearXNGResult[] {
  const seen = new Set(searxngResults.map(r => normalizeUrl(r.url)))
  const merged: SearXNGResult[] = [...searxngResults]
  for (const r of ollamaResults) {
    const key = normalizeUrl(r.url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push({ title: r.title, url: r.url, content: r.content })
  }
  return merged.slice(0, maxResults)
}

/**
 * Merge Ollama results into a plain results list for the BASIC path, with
 * content TRUNCATED to maxContentChars so results stay snippet-uniform (the
 * basic path returns snippets, not full crawled content). Deduped by URL.
 */
export function mergeOllamaIntoResults(
  items: SearchResultItem[],
  ollamaResults: OllamaSearchResult[],
  maxResults: number,
  maxContentChars: number
): SearchResultItem[] {
  const seen = new Set(items.map(i => normalizeUrl(i.url)))
  const merged: SearchResultItem[] = [...items]
  for (const r of ollamaResults) {
    const key = normalizeUrl(r.url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const content =
      r.content.length > maxContentChars
        ? r.content.slice(0, maxContentChars) + '…'
        : r.content
    merged.push({ title: r.title, url: r.url, content })
  }
  return merged.slice(0, maxResults)
}
