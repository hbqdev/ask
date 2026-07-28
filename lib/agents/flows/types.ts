/**
 * A control-flow variant: a genuinely different shape for the prompt→answer
 * loop, not a tuning of the existing one.
 *
 * WHY THIS EXISTS. The current flow is a pipeline with a mandatory first
 * stage: a classifier decides `skipSearch` before the model sees anything,
 * the system prompt then forbids the model from revisiting that judgement
 * ("you MUST run at least one search before answering"), and
 * resolveEffectiveDepth discards the model's own `search_depth` argument.
 * Measured consequence on 25 prod turns: every genuinely new question
 * searched, no matter how trivial, and the only zero-tool turns were
 * "summarise what we said" follow-ups.
 *
 * Each variant here is an answer to "what if the loop were shaped
 * differently", and they are meant to be compared against each other under
 * identical retrieval conditions (SearXNG only, see docker-compose.lab.yaml).
 *
 * WHAT A VARIANT MAY CHANGE, and why these specific levers: the AI SDK in use
 * is v6, which exposes `prepareStep` (called before EVERY step, including step
 * 0) and composable stop conditions. Between them they cover per-step control
 * of the system prompt, the visible tool set, forced/forbidden tool calls, and
 * termination. That is enough to express ReAct, plan-then-execute,
 * retrieve-once-wide and adaptive-retrieval without a second model pass.
 *
 * WHAT A VARIANT MAY NOT DO: resume a finished loop. The SDK ends the turn the
 * instant a step produces no tool calls, and there is no hook to restart it.
 * Anything needing "the model answered, now check it and continue" — such as
 * draft-then-verify — requires two sequential agent runs at a higher seam and
 * is deliberately out of scope for this registry.
 */
export type FlowVariant = {
  /** Registry key, also the value of FLOW_VARIANT. */
  id: string

  /** One line for the run report and the telemetry tag. */
  summary: string

  /**
   * Replaces the mode's system prompt entirely when present.
   *
   * Whole-prompt replacement rather than an appendix: quality mode is
   * currently balanced's prompt plus a 711-word delta that CONTRADICTS text
   * still sitting above it ("todoWrite is required" under "if in doubt, do NOT
   * use todoWrite"). Appending is how that happened, so variants own their
   * prompt outright.
   */
  buildPrompt?: (ctx: FlowPromptContext) => string

  /** Ceiling on steps. Falls back to the mode's own value when omitted. */
  maxSteps?: number

  /**
   * Per-step overrides. Returning `{}` leaves the step untouched.
   *
   * NOTE the SDK recomputes step input from initialMessages +
   * responseMessages every step, so anything injected here must be
   * re-injected on each later step rather than set once.
   */
  prepareStep?: (input: FlowStepInput) => FlowStepOverrides

  /**
   * Extra termination rule, ANDed with the step ceiling by the caller.
   * Return true to stop.
   */
  shouldStop?: (steps: readonly FlowStep[]) => boolean

  /**
   * Short status line shown in the research panel after each step, as a
   * synthetic `reasoning` part.
   *
   * This is how a variant gets Perplexity-style progress WITHOUT depending on
   * the model to narrate: measured on 25 prod turns, kimi-k2.6's reasoning
   * window averaged 1.9s and was 1.5s on a 91-second turn, so the model is not
   * filling that panel on its own. Returning null emits nothing.
   */
  stepStatus?: (input: FlowStepInput) => string | null
}

export type FlowPromptContext = {
  /** The mode prompt this variant is replacing, for reuse or reference. */
  basePrompt: string
  searchMode: string
  /** Classifier's verdict. A variant is free to ignore it — that is the point. */
  skipSearch: boolean
  hasUrl: boolean
}

/**
 * Minimal structural view of a completed step.
 *
 * Deliberately NOT the SDK's `StepResult<ToolSet>`: that generic is
 * instantiated with the researcher's concrete tool map, and its variance
 * fights any attempt to pass it through a tool-agnostic interface. Variants
 * only ever need the step index and which tools were called, so the contract
 * is stated in those terms and the SDK's richer type is narrowed at the one
 * call site in researcher.ts.
 */
export type FlowStep = {
  toolCalls?: readonly { toolName: string }[]
  text?: string
}

export type FlowStepInput = {
  stepNumber: number
  steps: readonly FlowStep[]
  /**
   * The classifier's verdict, threaded through so a variant can make it
   * BINDING rather than advisory.
   *
   * Today this decision only swaps the system prompt and tool list, and the
   * prompt then tells the model to search anyway — so the classifier's
   * judgement is expressed as a suggestion. The `router` variant exists to
   * test the opposite: decide on properties of the QUESTION, then enforce the
   * decision in code, which is what the adaptive-retrieval literature
   * consistently finds is required.
   */
  skipSearch: boolean
}

export type FlowStepOverrides = {
  system?: string
  activeTools?: string[]
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'tool'; toolName: string }
}

/** How many tool calls of a given name have been made so far. */
export function countToolCalls(
  steps: readonly FlowStep[],
  toolName?: string
): number {
  let n = 0
  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      if (!toolName || call.toolName === toolName) n++
    }
  }
  return n
}

/** True once any step has produced assistant prose (i.e. an answer began). */
export function hasEmittedText(steps: readonly FlowStep[]): boolean {
  return steps.some(s => (s.text ?? '').trim().length > 0)
}
