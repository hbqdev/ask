/**
 * Stop ADVERTISING `search` once the per-turn search round cap has fired
 * (stage 1), and switch the turn to answer-now if the model keeps calling it
 * anyway (stage 2, searchCalledAfterWithdrawal below).
 *
 * THE BUG THIS FIXES. Prod chat cznh8gc1gz41vq2lwjb560br (mistral-large-4,
 * balanced, cap 3): the cap in lib/tools/search.ts refused 80 search calls over
 * ~30 steps — 36 steps, 89 tool calls, 2.07M prompt tokens, 259s — before the
 * model answered on its own. Each refusal is a normal tool result whose only
 * stop signal is its `notice` text ("Search limit reached … Do not search
 * again"), and `search` stayed in activeTools on every later step. So the cap
 * stopped only models that obey tool-result instructions: every other model in
 * stored history stopped after 1-5 refusals.
 *
 * The fix is a pipeline lever, not a model one: from the step after the first
 * refused search, `search` is no longer offered. Everything else is offered
 * exactly as before — notably `fetch`, which quality mode's cap notice
 * deliberately still allows on URLs already found.
 *
 * This is ADVERTISING, not enforcement (AI SDK v6 executes a call against the
 * full tools map whatever activeTools says). The cap's execute-side refusal in
 * lib/tools/search.ts stays the backstop for a model that calls search anyway,
 * and such a call is what triggers stage 2.
 */

import {
  type AnswerDeadlineOverrides,
  answerNowOverrides
} from './answer-deadline'

/**
 * Structural view of a completed step: only what these checks read. In AI SDK
 * v6:
 * - `toolResults[j].output` is the tool's FINAL output — for the
 *   async-generator search tool, its last yield (preliminary yields are not
 *   recorded on the step).
 * - `toolCalls` has EVERY call the model made, including one whose input failed
 *   the tool's schema ("Invalid input for tool search"): that call is recorded
 *   with `invalid: true` and answered by a `tool-error` content part, with no
 *   tool result.
 */
export type SearchCapStep = {
  toolCalls?: readonly { toolName: string }[]
  toolResults?: readonly { toolName: string; output?: unknown }[]
}

/**
 * True once any earlier step of this turn has a `search` result carrying the
 * round-cap flag (`searchLimitReached: true`, set only by the cap in
 * lib/tools/search.ts; wrapSearchToolWithDedup re-yields it unchanged).
 *
 * Deliberately NOT the other empty search results: a near-duplicate skip
 * (`note: "Skipped: …"`), an exact repeat (`duplicateQuery`), a URL sent as a
 * query (guidance `notice`) and the answer-deadline refusal (`answerNow`) are
 * not the cap, and only the cap means no further search can run.
 */
export function searchCapReached(steps: readonly SearchCapStep[]): boolean {
  return firstCappedStep(steps) !== -1
}

/** Index of the first step with a round-cap refusal, or -1. */
function firstCappedStep(steps: readonly SearchCapStep[]): number {
  return steps.findIndex(step =>
    (step.toolResults ?? []).some(
      r =>
        r.toolName === 'search' &&
        typeof r.output === 'object' &&
        r.output !== null &&
        (r.output as { searchLimitReached?: unknown }).searchLimitReached ===
          true
    )
  )
}

/**
 * Fold the withdrawal into the step's per-step overrides.
 *
 * Filters whichever tool list is in force for the step — a flow variant's own
 * `activeTools` when it set one, otherwise the mode's list — so a variant's
 * choice is narrowed, never widened. Returns `overrides` itself (same object)
 * until the cap has fired, the same convention as applyAnswerDeadline, so the
 * caller can tell by identity whether it applied.
 *
 * Applied BEFORE applyAnswerDeadline: the deadline's `activeTools: []` must
 * still win, and does — it replaces the list outright.
 */
export function withdrawSearchAfterCap<T extends { activeTools?: string[] }>(
  overrides: T,
  {
    steps,
    defaultActiveTools
  }: {
    steps: readonly SearchCapStep[]
    /** The mode's activeToolsList: what the step offers with no override. */
    defaultActiveTools: readonly string[]
  }
): T {
  if (!searchCapReached(steps)) return overrides
  return {
    ...overrides,
    activeTools: (overrides.activeTools ?? defaultActiveTools).filter(
      name => name !== 'search'
    )
  }
}

/**
 * STAGE 2: the model kept calling `search` after it was withdrawn.
 *
 * Withdrawing `search` (above) is not enough for every model. Lab chat
 * jcckydan2uqv7l4qelyjq1ob (mistral-large-4, balanced): withdrawn at step 3,
 * the model still made 5 refused search calls on step 3, 3 calls on step 4
 * whose input failed the schema (it invented args for a tool it no longer
 * saw), and 7 more refused calls on steps 5-6. A direct Ollama replay matched:
 * offered only `fetch`, it emitted `search` anyway in 1 of 2 runs; offered NO
 * tools plus the answer-now note, it wrote the answer in 2 of 2.
 *
 * So once a step that ran without `search` still calls it — refused, invalid
 * input, or any other — the rest of the turn is answer-now: the answer
 * deadline's own override (no tools, ANSWER_NOW_NOTE), and researcher.ts's
 * enforceAnswerDeadline wrapper refuses any call the model emits anyway. A
 * model that complies (answers, or only fetches) never gets here.
 */
export function searchCalledAfterWithdrawal(
  steps: readonly SearchCapStep[]
): boolean {
  const capped = firstCappedStep(steps)
  if (capped === -1) return false
  // Steps after the capped one ran with `search` withdrawn. The capped step's
  // own calls (parallel ones included) were made while it was still offered.
  return steps
    .slice(capped + 1)
    .some(step => (step.toolCalls ?? []).some(c => c.toolName === 'search'))
}

/**
 * Fold stage 2 into the step's overrides. Returns `overrides` itself (same
 * object) until it applies, like withdrawSearchAfterCap.
 *
 * Applied after withdrawSearchAfterCap and BEFORE applyAnswerDeadline, so the
 * time deadline's identity check (its log, the citation reminder) still means
 * the time deadline only; both use answerNowOverrides, which adds the note
 * once when both fire.
 */
export function answerNowOnSearchEvasion<T extends AnswerDeadlineOverrides>(
  overrides: T,
  {
    steps,
    systemPrompt
  }: {
    steps: readonly SearchCapStep[]
    /** The turn's system prompt, as for applyAnswerDeadline. */
    systemPrompt: string
  }
): T {
  if (!searchCalledAfterWithdrawal(steps)) return overrides
  return answerNowOverrides(overrides, systemPrompt)
}
