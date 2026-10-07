/**
 * Stop ADVERTISING `search` once the per-turn search round cap has fired
 * (stage 1), and switch the turn to answer-now if the model keeps calling it
 * anyway (stage 2, searchCalledAfterWithdrawal below) or, in modes whose cap
 * notice says "answer now", keeps using other tools for more than a few steps
 * (stage 3, answerNowAfterPostCapToolSteps below).
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

import { resolveFetchRoundsBudget } from '../tools/fetch-budget'
import type { SearchMode } from '../types/search'

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

/**
 * STAGE 3: tool steps after the cap, in modes whose cap notice says "answer
 * now".
 *
 * Stages 1-2 stop the searching, not the turn. Lab chat
 * jcckydan2uqv7l4qelyjq1ob, follow-up turn (mistral-large-4, balanced): cap at
 * step 2, search withdrawn at step 3, no search call after it, then one
 * `fetch` per step on steps 3-15 (several 404s on constructed URLs) and the
 * answer at step 16: 17 steps, 1.21M prompt tokens, 268s. Balanced has no
 * fetch budget (lib/tools/fetch-budget.ts), and there the cap notice already
 * says "answer the user's question directly now" — nothing bounded the fetching
 * except the step ceiling and the 200s deadline.
 *
 * Stored history, steps that made tool calls after the first refused search
 * (all envs, balanced): deepseek-v4.1-flash 11 turns all 0, glm-5.3-flash 5
 * all 0, kimi-k2.6 5 all 0, deepseek-v4-pro 2 max 1, the delisted
 * deepseek-v4-flash 36 turns p90 4 max 6; mistral-large-4 32, 13 and 5. So 4
 * leaves every currently listed model's observed turns alone.
 *
 * Quality (a finite fetch budget, and a cap notice that deliberately allows
 * fetching found URLs) is not limited: there fetch-after-cap is the point.
 */
export const POST_CAP_TOOL_STEPS_MAX_DEFAULT = 4

/** Same rule as lib/tools/fetch-budget.ts: invalid or non-positive -> null. */
function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/**
 * How many tool-using steps a turn may take after the cap fired, or null for
 * no limit. Limited exactly where the cap notice says "answer now": modes with
 * no fetch budget (the same resolveFetchRoundsBudget test search.ts uses to
 * word the notice). POST_CAP_TOOL_STEPS_MAX overrides the default; an invalid
 * value falls back to it.
 */
export function resolvePostCapToolStepsLimit(
  searchMode?: SearchMode,
  env: Record<string, string | undefined> = process.env
): number | null {
  if (resolveFetchRoundsBudget(searchMode, env) !== null) return null
  return (
    positiveInt(env.POST_CAP_TOOL_STEPS_MAX) ?? POST_CAP_TOOL_STEPS_MAX_DEFAULT
  )
}

/**
 * Steps after the first capped one that made any tool call (an invalid-input
 * call included). A step with no tool call ends the loop, so in practice
 * these are the consecutive steps since the cap. 0 until the cap fires.
 */
export function toolStepsAfterCap(steps: readonly SearchCapStep[]): number {
  const capped = firstCappedStep(steps)
  if (capped === -1) return 0
  return steps
    .slice(capped + 1)
    .filter(step => (step.toolCalls ?? []).length > 0).length
}

/**
 * Fold stage 3 into the step's overrides: once `maxToolSteps` tool-using steps
 * have followed the cap, this step and every later one is answer-now (the
 * deadline's override; researcher.ts refuses calls exactly as for stage 2).
 * `maxToolSteps` null (resolvePostCapToolStepsLimit for quality) never
 * applies. Returns `overrides` itself until it applies.
 */
export function answerNowAfterPostCapToolSteps<
  T extends AnswerDeadlineOverrides
>(
  overrides: T,
  {
    steps,
    systemPrompt,
    maxToolSteps
  }: {
    steps: readonly SearchCapStep[]
    /** The turn's system prompt, as for applyAnswerDeadline. */
    systemPrompt: string
    maxToolSteps: number | null
  }
): T {
  if (maxToolSteps === null || toolStepsAfterCap(steps) < maxToolSteps) {
    return overrides
  }
  return answerNowOverrides(overrides, systemPrompt)
}
