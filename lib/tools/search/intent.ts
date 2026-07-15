// Single source of truth for auto-detected search intent (set by the query
// classifier) and its ADDITIVE SearXNG category. Imported by the classifier,
// the basic SearXNG provider, and the advanced-search route so the mapping
// never drifts across the two search paths.
//
// Additive contract: intent adds AT MOST one category on top of the always-on
// general baseline. 'general' adds nothing. Verified live that SearXNG unions
// `categories` with any pinned `engines`, so appending a category cannot
// starve the baseline — it only adds specialized engines.

export const SEARCH_INTENTS = [
  'general',
  'code',
  'discussion',
  'news',
  'academic'
] as const

export type SearchIntent = (typeof SEARCH_INTENTS)[number]

const INTENT_TO_CATEGORY: Record<SearchIntent, string | null> = {
  general: null, // baseline only — adds nothing
  code: 'it', // github, stackoverflow, mdn, pypi, npm, docker hub…
  discussion: 'social media', // hackernews, lobste.rs, lemmy, mastodon
  news: 'news', // google news, bing news… (pairs with needsRecent)
  academic: 'science' // arxiv, pubmed, scholar, semantic scholar, crossref…
}

// The additive category for an intent, or null when nothing should be added
// (general). Callers append the returned category to their existing
// `general,images` category list; null means leave the list unchanged.
export function intentToCategory(intent: SearchIntent): string | null {
  return INTENT_TO_CATEGORY[intent] ?? null
}
