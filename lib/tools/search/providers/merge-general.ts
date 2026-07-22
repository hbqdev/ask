import type { SearchResultItem, SearchResults } from '@/lib/types'

import { normalizeUrl } from './merge-degoog'

// The Brave provider maps web results as { title, description, url } (Brave's
// own field name) while SearchResultItem carries `content` — normalize so
// Brave snippets survive the merge instead of rendering empty.
type LooseResultItem = SearchResultItem & { description?: string }

function toResultItem(r: LooseResultItem): SearchResultItem {
  return {
    title: r.title,
    url: r.url,
    content: r.content ?? r.description ?? ''
  }
}

/**
 * Merge Brave (block-immune general API) and SearXNG (which itself merges
 * degoog + Ollama internally) results for a type="general" search, so general
 * searches keep the full self-hosted source union alongside Brave.
 *
 * - Text results: Brave first (its API ranking leads), then unique SearXNG
 *   URLs appended — uncapped, matching the expansion-variant merge precedent
 *   (comprehensiveness over a hard cap; both sides are already capped
 *   upstream by maxResults).
 * - Images/videos: taken from whichever side has them, Brave preferred — the
 *   two sides use different item shapes (Brave: SearchImageItem objects;
 *   SearXNG: URL strings), so they are not interleaved.
 *
 * Either side may be null (provider failed or returned nothing usable) — the
 * other side then carries the search. Callers must handle both-null themselves
 * (this returns an empty shell).
 */
export function mergeGeneralSearchResults(
  brave: SearchResults | null,
  searxng: SearchResults | null,
  query: string
): SearchResults {
  const seen = new Set<string>()
  const results: SearchResultItem[] = []
  for (const r of (brave?.results ?? []) as LooseResultItem[]) {
    const key = normalizeUrl(r.url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    results.push(toResultItem(r))
  }
  for (const r of (searxng?.results ?? []) as LooseResultItem[]) {
    const key = normalizeUrl(r.url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    results.push(toResultItem(r))
  }

  const images = brave?.images?.length ? brave.images : (searxng?.images ?? [])
  const videos = brave?.videos?.length ? brave.videos : (searxng?.videos ?? [])

  return {
    results,
    images,
    videos,
    query: brave?.query ?? searxng?.query ?? query,
    number_of_results: results.length
  }
}
