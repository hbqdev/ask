/**
 * Stop ADVERTISING `search` once the per-turn search round cap has fired.
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
 * lib/tools/search.ts stays the backstop for a model that calls search anyway.
 */

/**
 * Structural view of a completed step: only what this check reads. In AI SDK
 * v6 `steps[i].toolResults[j].output` is the tool's FINAL output — for the
 * async-generator search tool, its last yield (preliminary yields are not
 * recorded on the step).
 */
export type SearchCapStep = {
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
