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
  const seen = new Set<string>()
  const merged: SearXNGResult[] = []
  // Ollama first: it carries full content (the advanced route skips Crawl4AI
  // for these URLs) and is the hosted resilience source, so it must survive
  // the candidate-pool cap. Adding it first also means a URL collision keeps
  // Ollama's full content instead of a SearXNG/degoog snippet.
  for (const r of ollamaResults) {
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
  const seen = new Set<string>()
  const merged: SearchResultItem[] = []
  // Ollama first so it survives truncation when `items` already fill
  // maxResults, and wins over a SearXNG/degoog snippet on a URL collision.
  // Its content is still truncated to snippet size for basic-path uniformity.
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
  for (const i of items) {
    const key = normalizeUrl(i.url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(i)
  }
  return merged.slice(0, maxResults)
}
