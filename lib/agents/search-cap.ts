/**
 * Stop ADVERTISING `search` as soon as this turn's search budget is spent
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
 * The fix is a pipeline lever, not a model one: once the budget is spent,
 * `search` is no longer offered. Everything else is offered exactly as before —
 * notably `fetch`, which quality mode's cap notice deliberately still allows
 * on URLs already found.
 *
 * PROACTIVE, FROM THE TOOL'S OWN COUNTER. Stage 1 first fired only from the
 * step after a search came back refused, so every capped turn of every model
 * spent one step calling `search` just to discover the cap: the same prod
 * chat's later turn (budget 3) ran 5 searches by step 1, was still offered
 * search at step 2 and made 4 refused calls there; prod deepseek-v4.1-flash's
 * capped turns each spent a step on 1-2 refusals. Now the researcher reads the
 * search tool's round counter (SearchRoundCounter in lib/tools/search-rounds.ts:
 * searches that actually ran, so dedup skips and short-circuits never count)
 * before every step, and withdraws `search` on the first step that starts with
 * the budget spent. A refused result still withdraws it (searchBudgetSpent's
 * fallback). Stages 2 and 3 count from the step search was actually withdrawn
 * at, which the researcher records.
 *
 * This is ADVERTISING, not enforcement (AI SDK v6 executes a call against the
 * full tools map whatever activeTools says). The cap's execute-side refusal in
 * lib/tools/search.ts stays the backstop for a model that calls search anyway,
 * and such a call is what triggers stage 2.
 */

import { resolveFetchRoundsBudget } from '../tools/fetch-budget'
import {
  buildSearchWithdrawnNote,
  resolveSearchRoundsBudget
} from '../tools/search-rounds'
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
  return steps.some(step =>
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
 * STAGE 1's trigger: no further search can run this turn. True once the
 * search tool's own round counter has reached the budget (`roundsUsed`, read
 * from the turn's SearchRoundCounter, against resolveSearchRoundsBudget for
 * the mode), which is known before any search is refused. Also true once a
 * search came back refused (searchCapReached): a fallback for a search tool
 * whose counter the researcher cannot read; with the shared counter a refusal
 * implies the budget is spent anyway.
 */
export function searchBudgetSpent(
  steps: readonly SearchCapStep[],
  { roundsUsed, roundsBudget }: { roundsUsed: number; roundsBudget: number }
): boolean {
  return roundsUsed >= roundsBudget || searchCapReached(steps)
}

/**
 * Fold the withdrawal into the step's per-step overrides.
 *
 * `withdrawnAtStep` is the step at which searchBudgetSpent first held, as the
 * researcher recorded it (null until then); from it on, every step is
 * withdrawn. Filters whichever tool list is in force for the step — a flow
 * variant's own `activeTools` when it set one, otherwise the mode's list — so
 * a variant's choice is narrowed, never widened.
 *
 * Returns `overrides` itself (same object) unless this step actually loses
 * `search` — before the withdrawal, and also when the list in force has no
 * `search` to remove (a stable-knowledge turn, a variant's own search-free
 * list) — the same convention as applyAnswerDeadline, so the caller can tell
 * by identity that search disappeared (withSearchWithdrawnNote).
 *
 * Applied BEFORE applyAnswerDeadline: the deadline's `activeTools: []` must
 * still win, and does — it replaces the list outright.
 */
export function withdrawSearchAfterCap<T extends { activeTools?: string[] }>(
  overrides: T,
  {
    withdrawnAtStep,
    defaultActiveTools
  }: {
    withdrawnAtStep: number | null
    /** The mode's activeToolsList: what the step offers with no override. */
    defaultActiveTools: readonly string[]
  }
): T {
  if (withdrawnAtStep === null) return overrides
  const offered = overrides.activeTools ?? defaultActiveTools
  if (!offered.includes('search')) return overrides
  return {
    ...overrides,
    activeTools: offered.filter(name => name !== 'search')
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
 * So once a step that ran without `search` — the withdrawal step or any later
 * one — still calls it (refused, invalid input, or any other), the rest of the
 * turn is answer-now: the answer deadline's own override (no tools,
 * ANSWER_NOW_NOTE), and researcher.ts's enforceAnswerDeadline wrapper refuses
 * any call the model emits anyway. A model that complies (answers, or only
 * fetches) never gets here. Calls on earlier steps were made while `search`
 * was still offered (a step whose parallel calls ran past the budget
 * included), so they do not count.
 */
export function searchCalledAfterWithdrawal(
  steps: readonly SearchCapStep[],
  withdrawnAtStep: number | null
): boolean {
  if (withdrawnAtStep === null) return false
  return steps
    .slice(withdrawnAtStep)
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
    withdrawnAtStep,
    systemPrompt
  }: {
    steps: readonly SearchCapStep[]
    withdrawnAtStep: number | null
    /** The turn's system prompt, as for applyAnswerDeadline. */
    systemPrompt: string
  }
): T {
  if (!searchCalledAfterWithdrawal(steps, withdrawnAtStep)) return overrides
  return answerNowOverrides(overrides, systemPrompt)
}

/**
 * STAGE 3: tool steps after `search` was withdrawn, in modes whose cap notice
 * says "answer now".
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
 * Counted from the withdrawal step: the steps that ran without `search`. That
 * is what the sizing above measured (the capped step itself still offered
 * search and is not counted), and since search is withdrawn as soon as the
 * budget is spent, it is no longer necessarily the step after a refusal.
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
 * How many tool-using steps a turn may take once `search` is withdrawn, or
 * null for no limit. Limited exactly where the cap notice says "answer now": modes with
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
 * Steps from the withdrawal step on that made any tool call (an invalid-input
 * call included). A step with no tool call ends the loop, so in practice these
 * are the consecutive steps since search was withdrawn. 0 until then.
 */
export function toolStepsAfterWithdrawal(
  steps: readonly SearchCapStep[],
  withdrawnAtStep: number | null
): number {
  if (withdrawnAtStep === null) return 0
  return steps
    .slice(withdrawnAtStep)
    .filter(step => (step.toolCalls ?? []).length > 0).length
}

/**
 * Fold stage 3 into the step's overrides: once `maxToolSteps` tool-using steps
 * have run without `search`, this step and every later one is answer-now (the
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
    withdrawnAtStep,
    systemPrompt,
    maxToolSteps
  }: {
    steps: readonly SearchCapStep[]
    withdrawnAtStep: number | null
    /** The turn's system prompt, as for applyAnswerDeadline. */
    systemPrompt: string
    maxToolSteps: number | null
  }
): T {
  if (
    maxToolSteps === null ||
    toolStepsAfterWithdrawal(steps, withdrawnAtStep) < maxToolSteps
  ) {
    return overrides
  }
  return answerNowOverrides(overrides, systemPrompt)
}

/**
 * Stage 1's note for this mode: buildSearchWithdrawnNote with the mode's
 * budget, offering `fetch` exactly where the cap notice does (a mode with a
 * fetch budget, the same resolveFetchRoundsBudget test search.ts uses).
 */
export function resolveSearchWithdrawnNote(
  searchMode?: SearchMode,
  env: Record<string, string | undefined> = process.env
): string {
  return buildSearchWithdrawnNote(
    resolveSearchRoundsBudget(searchMode, env),
    resolveFetchRoundsBudget(searchMode, env) !== null
  )
}

/**
 * Stage 1's note: tell the model why `search` is gone (buildSearchWithdrawnNote
 * — it may never have seen a refusal), appended once to the prompt in force.
 *
 * Only on a step that actually lost `search` (`withdrawn !== offered`, see
 * withdrawSearchAfterCap) and where nothing replaced that withdrawal
 * (`step === withdrawn`): on an answer-now step — stage 2, stage 3 or the time
 * deadline — ANSWER_NOW_NOTE speaks alone, since quality's note ("you may
 * still fetch") would contradict "no tools". Applied last in prepareStep;
 * returns `step` itself when it does not apply.
 */
export function withSearchWithdrawnNote<T extends AnswerDeadlineOverrides>(
  step: T,
  {
    offered,
    withdrawn,
    systemPrompt,
    note
  }: {
    /** The step's overrides before withdrawSearchAfterCap. */
    offered: T
    /** What withdrawSearchAfterCap returned for them. */
    withdrawn: T
    /** The turn's system prompt, as for applyAnswerDeadline. */
    systemPrompt: string
    note: string
  }
): T {
  if (withdrawn === offered || step !== withdrawn) return step
  const base = step.system ?? systemPrompt
  const suffix = `\n\n${note}`
  return {
    ...step,
    system: base.endsWith(suffix) ? base : `${base}${suffix}`
  }
}
