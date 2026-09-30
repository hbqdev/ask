import { isCitationHandlesEnabled } from '../utils/citation-handles'

import { countToolCalls, type FlowStep } from './flows/types'

/**
 * Re-state the citation contract right before the answer once a research loop
 * has run long.
 *
 * THE PROBLEM, from stored answers. The citation rules live only in the system
 * prompt, the first message. Every search or fetch call appends a tool result
 * after it, so on a long loop the step that writes the answer starts 100k+
 * tokens and a dozen or more tool turns away from those rules. Lab history,
 * 296 answers of 1,500+ characters over 60 days (5 models):
 *
 *   search+fetch calls   turns   anchors per 1k chars (mean, min-max)
 *   1-2                   167    3.61  (0.32-7.80)   no turn without anchors
 *   3-4                    64    3.42  (0.53-6.80)   no turn without anchors
 *   5-7                    45    3.10  (0.57-6.23)   no turn without anchors
 *   8-11                   16    3.45  (2.66-5.42)   no turn without anchors
 *   12+                     4    0.95  (0.00-1.38)   one turn with none
 *
 * The four 12+ turns are two models (kimi-k2.6, glm-5.3-flash) in two modes.
 * In the 2026-09-29 quality round-cap A/B, the 18-call turn (103k-token final
 * prompt) wrote 13.9k characters with no citation of any form, and the
 * 15-call turn numbered its sources itself: a running count under whole
 * sections ("Sources: [1] [2] [4]") plus a reference list, 4 of whose anchors
 * pointed past the cited call's results. No pipeline stage explains either:
 * neither turn hit the answer deadline, the step ceiling or the search cap,
 * and nothing is pruned inside a turn (the per-step prompt grew monotonically
 * to the end). Prompt size alone does not separate them: an 8-call turn of the
 * same A/B answered from a 107k-token prompt with 36 claim-level citations.
 *
 * REPLAYS. The final step of both turns was rebuilt from the stored parts with
 * the real createResearcher prompt and tools (prompt tokens matched the logged
 * ones exactly) and sent to kimi-k2.6 again:
 * - Unchanged, it cited badly again. 3 of the 5 answers numbered sources as a
 *   running count across the answer and a 4th partly (single-page fetches
 *   cited as [1], the only correct number: 5 of 18), and in the 18-call
 *   context it emitted a search call 4 times out of 6 instead of answering,
 *   twice with no tools advertised at all.
 * - A trailing SYSTEM message is a no-op there: Ollama drops a system message
 *   that is not the first one for kimi-k2.6 (prompt_eval_count unchanged; the
 *   same probe on glm-5.3-flash did render it).
 * - The reminder inside the last tool result did not change the research
 *   decision, but did not fix the 15-call context (2 of 2 answers still a
 *   running count).
 * - The reminder as a trailing USER message fixed it: 7 of 9 answers copied
 *   the `cite` strings (single-page fetches cited as [1]: 91 of 91), one
 *   partly, one still counted. But it also steered the research loop, and in a
 *   wording-dependent direction (see lib/agents/answer-step-reminder.ts), so
 *   it is only shown on the step that writes the answer.
 *
 * So: on a step with at least CITATION_REMINDER_MIN_TOOL_CALLS search/fetch
 * calls behind it, the step runs through createAnswerStepReminderModel, which
 * re-runs it with this reminder as a trailing user message only once the
 * model has started writing the answer. On the answer-deadline step (tools
 * withdrawn, so the step is the answer by construction) the reminder is simply
 * appended. Per-step and never persisted: the SDK rebuilds each step's input
 * from the turn's own messages, so no reminder is stored or piles up.
 *
 * Kill switch: CITATION_REMINDER=off. Threshold:
 * CITATION_REMINDER_MIN_TOOL_CALLS (default 8: every turn with 12+ calls
 * degraded, and 8-11 is the widest bucket without a degraded turn, so the
 * reminder is in place before the drop).
 */
export const CITATION_REMINDER_MIN_TOOL_CALLS_DEFAULT = 8

export function isCitationReminderEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.CITATION_REMINDER !== 'off'
}

export function resolveCitationReminderMinToolCalls(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.CITATION_REMINDER_MIN_TOOL_CALLS
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : CITATION_REMINDER_MIN_TOOL_CALLS_DEFAULT
}

/** Search and fetch calls made so far this turn: the calls that yield citable results. */
export function countCitableToolCalls(steps: readonly FlowStep[]): number {
  return countToolCalls(steps, 'search') + countToolCalls(steps, 'fetch')
}

/**
 * The reminder text. Follows CITATION_HANDLES: with handles on, the model
 * copies each result's `cite` string; off, it composes [N](#toolCallId) the
 * way the flag-off prompt describes.
 *
 * Worded for the step that writes the answer: that is the only step that
 * sees it.
 */
export function getCitationReminderText(): string {
  const how = isCitationHandlesEnabled()
    ? "- To cite a result, copy that result's `cite` string exactly as it appears in the tool output. Never build a citation yourself, and never change the number or the id in a `cite` string."
    : "- To cite a result, write [N](#toolCallId): toolCallId is the full id of the search or fetch call that returned it, and N is the result's position in THAT call's `results` (every call starts again at 1; a fetch of one page is always [1])."
  return [
    '[Citation format reminder from the system. It is not a new question. Do not reply to it or mention it.]',
    'The citation rules given at the start apply in full to your answer:',
    '- Cite inline: every sentence that uses information from a search or fetch result ends with its citation, right after the period.',
    how,
    '- Never number the sources yourself: no running count across the answer, and no "Sources:" line or reference list under a section or at the end.',
    '- Cite only results from this turn. A sentence that uses no result gets no citation.'
  ].join('\n')
}

export type CitationReminderMode = 'none' | 'answer-step' | 'append'

/**
 * How this step gets the reminder.
 *
 * - `append`: the answer deadline withdrew the tools (applyAnswerDeadline
 *   fired), so this step writes the answer: append the reminder directly.
 * - `answer-step`: enough search/fetch calls are behind this step; run it
 *   through createAnswerStepReminderModel, which adds the reminder only if
 *   the step turns out to be the answer.
 * - `none`: disabled, nothing citable yet, or below the threshold.
 */
export function resolveCitationReminderMode({
  citableToolCalls,
  answerDeadlinePassed = false,
  env = process.env
}: {
  citableToolCalls: number
  answerDeadlinePassed?: boolean
  env?: Record<string, string | undefined>
}): CitationReminderMode {
  if (!isCitationReminderEnabled(env)) return 'none'
  if (citableToolCalls < 1) return 'none'
  if (answerDeadlinePassed) return 'append'
  return citableToolCalls >= resolveCitationReminderMinToolCalls(env)
    ? 'answer-step'
    : 'none'
}

/**
 * The step's messages with the reminder appended as a trailing USER message.
 * Never mutates `messages`.
 *
 * User, not system: see the replays above. Every chat template renders a user
 * message where it stands.
 */
export function withCitationReminder<M>(
  messages: readonly M[]
): (M | { role: 'user'; content: string })[] {
  return [...messages, { role: 'user', content: getCitationReminderText() }]
}
