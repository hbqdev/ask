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

// `wikipedia` was REMOVED 2026-07-28. SearXNG's wikipedia engine answers with
// an INFOBOX, not result rows — measured across four query shapes it returned
// `results: 0` every time, while `infoboxes` held the content. Ask reads only
// `data.results` and `data.number_of_results` (searxng.ts) and never touches
// infoboxes anywhere in lib/ or app/, so every advanced search was paying a
// round trip to receive nothing.
//
// It failed silently in both directions: 0 results, and never reported as
// unresponsive, so neither the engine-health gate nor the logs ever flagged it.
// Re-adding it only makes sense alongside code that actually consumes
// infoboxes.
export const SEARXNG_ENGINES_ADVANCED = 'bing,duckduckgo,google cse'

export const SEARXNG_ENGINES_BASIC = 'bing,google cse'
