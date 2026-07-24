// SearXNG engine pin lists, shared by the search provider
// (lib/tools/search/providers/searxng.ts) and the advanced-search fan-out
// (app/api/advanced-search/route.ts) so the two never drift.
//
// `google cse` queries Google's Programmable Search (Custom Search Element)
// widget endpoint — a DIFFERENT surface from the scraped `google` SERP engine.
// The scraper is intermittently CAPTCHA-blocked from our residential IP; the
// CSE endpoint is not, so it keeps returning Google-quality results (and in
// practice contributes the largest share). The space in "google cse" is the
// engine's real name; SearXNG splits the `engines` param on commas, so it must
// stay a single comma-delimited element.

export const SEARXNG_ENGINES_ADVANCED =
  'google,bing,duckduckgo,wikipedia,google cse'

export const SEARXNG_ENGINES_BASIC = 'google,bing,google cse'
