import type { SearchMode } from '@/lib/types/search'

/**
 * The per-turn search-ROUND budget, its counter, and the texts that tell the
 * model it is spent. Enforced inside the search tool (createSearchTool in
 * ./search.ts); read by the researcher, which stops offering `search` as soon
 * as the budget is spent (lib/agents/search-cap.ts).
 *
 * Kept apart from ./search.ts so the researcher and search-cap.ts can read the
 * budget without importing the search tool's module (its providers, crawler
 * client and embedder), which researcher tests replace wholesale.
 */

// Per-turn search-ROUND cap (model-agnostic latency guard). The answering
// model can loop the `search` tool many times per turn; each round is a full
// fan-out + crawl + rerank PLUS the model's inter-call reasoning, and once
// recall/classifier/crawl are trimmed that looping dominates the remaining
// latency (measured on prod: up to 7 rounds ≈ 15s of fan-out + ~57s of
// inter-call reasoning). Capping ROUNDS is a PIPELINE lever: it bounds ANY
// answering model — loopy or not — without touching the model itself.
//
// Mode-aware: quality is crawl-heavy and multi-facet by design, so it gets a
// higher ceiling; balanced/speed/default share the lower one. Speed normally
// answers in a single Ollama-web pass, so the cap is only a safety net there.
// Env-overridable via SEARCH_ROUNDS_MAX / SEARCH_ROUNDS_MAX_QUALITY. Pure +
// exported so the budget resolution is unit-testable without a tool context.
const SEARCH_ROUNDS_MAX_DEFAULT = 3
// Quality 5 -> 10 (lab A/Bs 2026-09-29/30): cap 5 refused searches on every
// quality turn; with fetch-past-cap allowed, cap 10 vs 5 showed no measurable
// latency or quality difference and ties the cap-15 answers. 10 refused none of
// the real searches the cap-15 arm made (7/5/10) once dedup skips stopped
// counting.
const SEARCH_ROUNDS_MAX_QUALITY_DEFAULT = 10

export function resolveSearchRoundsBudget(
  searchMode?: SearchMode,
  env: Record<string, string | undefined> = process.env
): number {
  if (searchMode === 'quality') {
    const raw = Number(env.SEARCH_ROUNDS_MAX_QUALITY)
    return Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : SEARCH_ROUNDS_MAX_QUALITY_DEFAULT
  }
  const raw = Number(env.SEARCH_ROUNDS_MAX)
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : SEARCH_ROUNDS_MAX_DEFAULT
}

/**
 * A turn's search rounds so far: the searches that actually RAN. Not a round:
 * a near-duplicate skip, the cap's own refusal, the researcher wrapper's
 * exact-repeat and URL-as-query short-circuits (they return before the search
 * tool runs), and a call refused on an answer-now step.
 *
 * The researcher creates one per turn and hands it to createSearchTool
 * (SearchToolOptions.searchRounds), which is the only writer; the researcher
 * reads `used` before each step. It is the round cap's own counter, not a
 * second count of it.
 */
export type SearchRoundCounter = { used: number }

const NO_NARRATION =
  'Do NOT restate that a limit was reached, do NOT describe what each source gave you, and do NOT narrate that you are stopping or promise another search'

/**
 * The result text a search past the round cap returns.
 *
 * `allowFetch` is true when the turn's mode has a fetch cap
 * (resolveFetchRoundsBudget). Then the notice ends the SEARCHING only: the
 * model may still read, in full, pages that this turn's searches already
 * returned. The earlier wording, "Answer ... directly now using the sources
 * already gathered. Do not search again.", also ended the fetching. In the
 * 2026-09-29 quality A/B the cap-5 arm hit the cap in all 3 turns and then made
 * 1 fetch across the 3 of them, and its errors came from answering off
 * snippets. The cap-15 arm fetched 34 pages, and its wins came from those pages.
 *
 * Without a fetch cap (balanced/speed by default) the notice keeps the "answer
 * now" instruction: a fetch that nothing bounds except the answer deadline is
 * not offered.
 */
export function buildSearchRoundCapNotice(
  roundsBudget: number,
  allowFetch: boolean
): string {
  if (!allowFetch) {
    return `Search limit reached (${roundsBudget} rounds). Answer the user's question directly now using the sources already gathered. Do not search again. ${NO_NARRATION} — begin your reply immediately with its \`## \` heading.`
  }
  return `Search limit reached (${roundsBudget} rounds), so this search was not run. Do not call \`search\` again this turn: further searches are refused and return nothing. You may still call \`fetch\` on URLs that appeared in this turn's earlier search results when a specific claim in your answer needs that page's full text (put several URLs in one call). Otherwise, answer the user's question now from the sources already gathered. ${NO_NARRATION} — when you answer, begin your reply immediately with its \`## \` heading.`
}

/**
 * The system-prompt note for a step that no longer offers `search` because
 * the budget is spent (lib/agents/search-cap.ts withSearchWithdrawnNote).
 *
 * Since search is withdrawn as soon as the budget is spent, a model can lose
 * the tool without ever having had a search refused, so without ever reading
 * buildSearchRoundCapNotice. A model quietly denied a tool can spend its step
 * reasoning about retrying and write no prose (ANSWER_NOW_NOTE in
 * lib/agents/answer-deadline.ts), so it is told why, in the same words and
 * with the same fetch rule as the cap notice for its mode.
 */
export function buildSearchWithdrawnNote(
  roundsBudget: number,
  allowFetch: boolean
): string {
  const gone = `Search limit reached (${roundsBudget} rounds): \`search\` is no longer available this turn, and a call to it is refused and returns nothing.`
  if (!allowFetch) {
    return `${gone} Answer the user's question directly now using the sources already gathered. ${NO_NARRATION} — begin your reply immediately with its \`## \` heading.`
  }
  return `${gone} You may still call \`fetch\` on URLs that appeared in this turn's earlier search results when a specific claim in your answer needs that page's full text (put several URLs in one call). Otherwise, answer the user's question now from the sources already gathered. ${NO_NARRATION} — when you answer, begin your reply immediately with its \`## \` heading.`
}
