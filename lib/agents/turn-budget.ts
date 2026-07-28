// The turn's wall-clock budget, shared by the chat route (which enforces the
// hard abort) and the researcher loop (which must finish BEFORE it).
//
// WHY THIS EXISTS. The route aborts a turn at GENERATION_TIMEOUT_MS, but the
// agent loop had no notion of elapsed time at all — its only stop conditions
// were stepCountIs() and an optional variant hook. So a slow turn was killed
// mid-tool-call, and because the model never reached the step where it writes
// prose, the abort produced NO ANSWER AT ALL: no assistant message, no usage,
// nothing persisted. The user simply got silence.
//
// Measured across nine runs of the current-events conversation, reconstructed
// from lab Postgres: turn 2 produced no answer in EIGHT of them, before and
// after this module existed. Time-to-first-token on those turns was ~5s and
// every instrumented stage was fast (classify 1.3s, recall 2.8s), so the whole
// budget goes inside the agent loop.
//
// The dominant cost there is the MODEL call, not tools: one failing step
// spanned 268.5s around a single `fetch`, which is capped near 45s. This
// module does not bound model calls, so it does NOT fix that turn — see the
// note on wrapToolWithBudget in researcher.ts.
//
// A bigger ceiling alone does not fix that; it just moves the cliff. The
// intent is to STOP RETRIEVING while enough budget remains to write from what
// is already gathered — a partial answer from three good sources beats silence
// at 300 seconds. That intent is only partly realised today.

/** Hard abort. The route enforces this; nothing survives past it. */
export const GENERATION_TIMEOUT_MS = 300_000

/**
 * When the loop must stop calling tools and produce prose. Deliberately a
 * fraction rather than a fixed offset so the two move together if the ceiling
 * is ever retuned.
 *
 * 0.7 leaves ~90s to write. That is generous for prose, and intentionally so:
 * the answer step still has to ingest everything retrieved so far, which on a
 * large candidate pool is the single slowest model call of the turn.
 */
export const ANSWER_DEADLINE_FRACTION = 0.7

export const ANSWER_DEADLINE_MS = Math.floor(
  GENERATION_TIMEOUT_MS * ANSWER_DEADLINE_FRACTION
)

/**
 * Instruction injected when the deadline fires. It states the situation rather
 * than just forbidding tools, because a model told only "no tools" tends to
 * apologise for being unable to search instead of answering from what it has.
 */
export const ANSWER_NOW_DIRECTIVE = [
  'You have run out of research time for this turn.',
  'Do NOT call any further tools. Answer NOW using only what you have already retrieved.',
  'Write the best complete answer the gathered sources support.',
  'If some part of the question is not covered by what you retrieved, say so in one short clause and answer the rest — do not apologise at length and do not describe your search process.'
].join(' ')

/** Has this turn used up its retrieval budget? */
export function retrievalBudgetSpent(
  startedAtMs: number,
  now: number = Date.now()
): boolean {
  return now - startedAtMs >= ANSWER_DEADLINE_MS
}
