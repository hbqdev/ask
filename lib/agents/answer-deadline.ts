/**
 * Stop the research loop searching in time to actually write the answer.
 *
 * THE BUG THIS FIXES, measured on 80 balanced-mode turns against the lab:
 *
 *   p11  303.5s  17 steps  23 tool calls  0 characters
 *   p08  300.0s  18 steps  17 tool calls  0 characters
 *
 * Both hit `GENERATION_TIMEOUT_MS` in app/api/chat/route.ts, which aborts the
 * turn and persists NOTHING — so the user waited five minutes and got a blank
 * page. Four more turns landed between 245s and 276s, within seconds of the
 * same outcome, so this is not a rare tail: roughly 2 in 80 blanked and 1 in 13
 * came close.
 *
 * The cause is that `maxSteps` (50 in balanced mode) is a STEP budget with no
 * awareness of the clock. A turn that searches 17 times has spent its wall
 * clock long before it has spent its steps, and nothing tells it to stop and
 * write.
 *
 * A step ceiling alone cannot fix this. Lowering maxSteps would stop the loop
 * earlier, but the SDK ends a turn wherever it stops — and if the last step was
 * a tool call, that is still an empty answer, just a faster one. What is needed
 * is a step the model can ONLY answer in: no tools, and an instruction saying
 * so. That is what this provides.
 */

/**
 * Elapsed turn time after which the model gets no more tools.
 *
 * Derived from the route's own ceiling rather than picked: route.ts aborts at
 * 300s, and the reserve is worthless unless there is real time left to write
 * in. 200s leaves 100s — comfortably above the observed generation phase (the
 * longest loop answers in the sample ran ~7,900 characters, and text streaming
 * measured 9-17s) with wide margin for a slow first token.
 *
 * Deliberately NOT tuned to be tight. Firing early costs a turn some extra
 * searching it probably did not need; firing late costs the turn its entire
 * answer. Those are not symmetric.
 */
export const ANSWER_DEADLINE_MS = 200_000

/**
 * The instruction that accompanies the tool removal.
 *
 * Taking the tools away is not sufficient on its own — measured separately on
 * the flow-design branch, a model silently prevented from calling a tool spent
 * its step reasoning about retrying and emitted no prose at all. It does not
 * infer that it should now answer; it has to be told.
 */
export const ANSWER_NOW_NOTE = [
  '',
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  'TIME TO ANSWER — NO MORE RESEARCH THIS TURN',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  'This turn has used its research budget. Your tools have been removed — another tool call is impossible and will not run.',
  '',
  '- Write the best complete answer you can NOW, from the search results already in this conversation.',
  '- Do NOT announce that you are running out of time, do NOT propose further searches, and do NOT mention tools or their absence.',
  '- If something you wanted to verify is missing, say so in one short clause and answer the rest normally.'
].join('\n')

export type AnswerDeadlineOverrides = {
  activeTools?: string[]
  system?: string
}

/**
 * Fold the deadline into whatever per-step overrides are already in force.
 *
 * Applied LAST, so it wins over a flow variant's own per-step tool preferences:
 * a variant tuning which tools are visible mid-loop is a preference, and having
 * a step left to answer in is not.
 *
 * `elapsedMs` is injected rather than read from a clock inside, so this stays a
 * pure function and the boundary is testable without faking time.
 */
export function applyAnswerDeadline<T extends AnswerDeadlineOverrides>(
  overrides: T,
  {
    elapsedMs,
    systemPrompt,
    deadlineMs = ANSWER_DEADLINE_MS
  }: {
    elapsedMs: number
    /**
     * The turn's system prompt. Required because `system` here REPLACES the
     * step's instructions rather than adding to them — sending the note alone
     * would discard every prompt rule, including the citation contract.
     */
    systemPrompt: string
    deadlineMs?: number
  }
): T {
  if (elapsedMs < deadlineMs) return overrides
  return {
    ...overrides,
    activeTools: [],
    // A variant that already replaced the prompt keeps its replacement; the
    // note is appended to whichever prompt is actually in force.
    system: `${overrides.system ?? systemPrompt}${ANSWER_NOW_NOTE}`
  }
}
