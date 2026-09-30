import type { SearchMode } from '@/lib/types/search'

/**
 * Per-turn cap on `fetch` calls, the companion of the search round cap
 * (resolveSearchRoundsBudget in lib/tools/search.ts).
 *
 * WHY. Once the search round cap is reached, its notice now lets the model
 * keep reading pages that earlier searches already returned
 * (buildSearchRoundCapNotice). The quality-mode A/B (lab, 2026-09-29) showed
 * that fetching full pages is where the accuracy came from: the cap-5 arm made
 * 1 fetch across 3 turns and reported a Lancet trial as null from a 401-char
 * snippet, while the cap-15 arm fetched 34 pages and read that the primary
 * endpoint was met. Before this cap, fetch had no per-turn bound at all: only
 * FETCH_MAX_URLS (5 urls per call), the 40s per-url deadline in fetch.ts, the
 * mode's step ceiling (100 in quality) and the 200s answer deadline. A model
 * that keeps fetching after the search cap could therefore spend the rest of
 * the turn's clock, and every page can add up to 50k characters of context.
 *
 * Counted in CALLS, like search rounds: each call is one model round trip
 * plus up to FETCH_MAX_URLS pages fetched concurrently.
 *
 * Sized from the A/B: the cap-15 arm made 6, 3 and 7 fetch calls (16, 8 and
 * 10 pages) per quality turn, so 8 does not restrict any turn observed there.
 *
 * Quality only by default. Balanced and speed keep today's behaviour, with no
 * fetch cap, unless FETCH_ROUNDS_MAX is set. The search cap notice offers fetch
 * only in modes where this budget is finite, so a mode without a fetch cap
 * keeps its "answer now" wording.
 */
export const FETCH_ROUNDS_MAX_QUALITY_DEFAULT = 8

function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/**
 * The number of `fetch` calls a turn in this mode may make, or null when the
 * mode has no fetch cap. Invalid or non-positive overrides fall back to the
 * default, the same rule resolveSearchRoundsBudget applies.
 */
export function resolveFetchRoundsBudget(
  searchMode?: SearchMode,
  env: Record<string, string | undefined> = process.env
): number | null {
  if (searchMode === 'quality') {
    return (
      positiveInt(env.FETCH_ROUNDS_MAX_QUALITY) ??
      FETCH_ROUNDS_MAX_QUALITY_DEFAULT
    )
  }
  return positiveInt(env.FETCH_ROUNDS_MAX)
}

/**
 * The refusal a fetch call past the budget returns. A valid, NON-error result,
 * like the search round cap's, so the model reads an instruction rather than a
 * failure it might retry.
 */
export function buildFetchLimitNotice(budget: number): string {
  return `Fetch limit reached (${budget} fetch calls this turn), so this fetch was not run and further fetch calls return nothing. Use the pages and search results already gathered. Do NOT restate that a limit was reached, do NOT describe what each source gave you, and do NOT narrate that you are stopping — when you answer, begin your reply immediately with its \`## \` heading.`
}
