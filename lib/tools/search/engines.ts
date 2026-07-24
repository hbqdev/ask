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
//
// The scraped `google` engine is DEACTIVATED (2026-07-24): from our flagged
// residential IP it returns DECOY results — a keyword-literal/degraded SERP
// ("best…" → dictionary + Best Buy) that passes as valid (count>0, no error)
// but is semantically worthless, poisoning the candidate pool. `google cse`
// replaces it as the Google source. Re-add 'google' here if the IP recovers.

export const SEARXNG_ENGINES_ADVANCED = 'bing,duckduckgo,wikipedia,google cse'

export const SEARXNG_ENGINES_BASIC = 'bing,google cse'
