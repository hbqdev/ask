import { countToolCalls, type FlowVariant } from './types'

/**
 * Shared grounding contract.
 *
 * Every variant that lets the model skip retrieval needs this, because the
 * rule it replaces — "you MUST run at least one search before answering",
 * "Do NOT answer from memory or conversation history alone" — is scar tissue.
 * Someone wrote it in that much caps for a reason, and the obvious reason is a
 * model answering confidently from training data and citing nothing. Removing
 * the mandate without replacing the property it protected would trade a
 * latency problem for a grounding problem, which is far worse for a search
 * engine.
 *
 * So: the model may decline to search, but it must SAY it is answering from
 * its own knowledge, and it must never manufacture a citation for a source it
 * did not retrieve. An uncited honest answer is acceptable; a fabricated
 * anchor is not.
 */
const GROUNDING_CONTRACT = `
Grounding contract (applies whenever you answer without searching):
- You MAY answer directly from your own knowledge when the question is stable, general, and not about anything recent, local, personal, numeric-and-current, or specific to a named product/version/price.
- When you do, open with a short plain statement that you are answering from your own knowledge and did not search.
- NEVER write a citation anchor for a source you did not actually retrieve this turn. An answer with no citations is fine; an invented anchor is not.
- If ANY part of the question needs current, cited, or verifiable fact, search for that part rather than guessing at it.
- If you are unsure whether your knowledge is current enough, search. Uncertainty is a reason to search, not to hedge.`

const CITATION_RULES = `
Citations:
- Cite inline as [number](#toolCallId), using ONLY toolCallIds from tools you actually called this turn.
- Put the citation after the sentence's closing period.
- Never invent, guess at, or reuse an id.`

const OUTPUT_RULES = `
Output:
- Your final answer must START with a \`## \` heading. No preamble, no "here is", no self-talk before it.
- Match length and structure to the question. Short question, short answer.
- Use tables for comparisons. Use concrete numbers and dates over vague qualifiers.`

const SILENT_EXECUTION = `
- Do NOT write prose between tool calls. Call tools back-to-back; the only text you produce is the final answer.`

/**
 * A — control. The unmodified existing flow.
 *
 * Deliberately does nothing at all: no prompt override, no prepareStep, no
 * stop condition. Every other arm is measured against this, so it has to be
 * genuinely untouched rather than a reimplementation that happens to look the
 * same.
 */
const baseline: FlowVariant = {
  id: 'baseline',
  summary: 'unchanged current flow: classifier pre-decides, search is mandatory'
}

/**
 * B — adaptive retrieval. The model decides whether to retrieve at all.
 *
 * The single change with the largest expected effect: today EVERY genuinely
 * new question searches, because the prompt mandates it. This removes the
 * mandate and hands the decision to the model, keeping grounding via contract
 * rather than compulsion.
 *
 * Nothing is forced or forbidden in code — the whole point is to measure the
 * model's own judgement, so a prepareStep that nudged it would corrupt the
 * measurement.
 */
const adaptive: FlowVariant = {
  id: 'adaptive',
  summary: 'no mandatory search; model decides whether to retrieve',
  buildPrompt: () => `Instructions:

You are a research assistant. Decide for yourself whether this question needs a web search.

Decide first, then act:
- Stable general knowledge, definitions, explanations of established concepts, arithmetic, language tasks, or anything you can answer correctly without checking → answer directly, no tools.
- Anything current, versioned, priced, local, personal, statistical, or that a reasonable person would want a source for → search first.
- A URL in the question → fetch it, do not search.
- A follow-up answerable from what is already in this conversation → answer directly.
${GROUNDING_CONTRACT}

When you do search:
- One search is often enough. Search again only when the results left a specific gap you can name.
- Read a promising page in full with the fetch tool rather than re-searching for depth. Pass an array of urls to fetch several at once.
${SILENT_EXECUTION}
${CITATION_RULES}
${OUTPUT_RULES}`
}

/**
 * C — ReAct with an explicit gap check.
 *
 * Modelled on what Perplexity visibly does: restate the task, act, then open
 * every subsequent step by assessing what is now known and naming what is
 * still missing ("U12104: need price"), and let that gap drive the next call.
 * Iteration is gap-driven rather than plan-driven or budget-driven.
 *
 * prepareStep re-injects the gap question on every step after the first,
 * because the SDK recomputes step input each time and a one-shot instruction
 * would be diluted by accumulating tool output.
 */
const reactGap: FlowVariant = {
  id: 'react-gap',
  summary: 'assess → act → reassess; iteration driven by named gaps',
  maxSteps: 24,
  buildPrompt: () => `Instructions:

You are a research assistant working in a loop: assess, act, reassess.

Every step:
1. State in one line what you now know and what is still MISSING. Name the gap concretely ("need current price", "no source for the 2026 figure"), not vaguely ("need more info").
2. If nothing is missing, write the answer.
3. Otherwise make exactly the tool call that closes that gap.

Rules:
- Do not plan the whole run up front. Plan only the next action.
- Do not repeat a search that already returned what you needed; if results were thin, change the phrasing rather than reissuing it.
- Read a promising page in full with fetch rather than re-searching for depth. Pass an array of urls to fetch several at once.
- Some questions have no gaps at all and need no tools. Answer those immediately.
${GROUNDING_CONTRACT}
${SILENT_EXECUTION}
${CITATION_RULES}
${OUTPUT_RULES}`,
  prepareStep: ({ stepNumber }) =>
    stepNumber === 0
      ? {}
      : {
          system: `Reassess before acting. In one line: what do you now know, and what is still missing? If nothing is missing, write the final answer starting with "## ". Otherwise make the single tool call that closes the named gap.
${SILENT_EXECUTION}
${CITATION_RULES}
${OUTPUT_RULES}`
        },
  stepStatus: ({ stepNumber, steps }) => {
    if (stepNumber === 0) return 'Assessing the question'
    const searches = countToolCalls(steps, 'search')
    const fetches = countToolCalls(steps, 'fetch')
    const parts = []
    if (searches) parts.push(`${searches} search${searches > 1 ? 'es' : ''}`)
    if (fetches) parts.push(`${fetches} page${fetches > 1 ? 's' : ''} read`)
    return parts.length
      ? `Reassessing after ${parts.join(', ')}`
      : 'Reassessing'
  }
}

/**
 * D — plan then execute.
 *
 * Produces a written plan artifact BEFORE any retrieval, then executes against
 * it. This is the one mechanism with a hard published number behind it: in
 * STORM's ablation, removing the outline stage collapsed ROUGE-1 from 45.82 to
 * 26.77, and both Anthropic's and LangChain's systems persist a plan outside
 * the conversation for the same reason.
 *
 * Step 0 is FORCED to todoWrite via toolChoice, because a prompt asking for a
 * plan first is exactly the kind of instruction models skip when the question
 * looks easy — and an unenforced plan stage is what quality mode already has.
 * From step 1 the system prompt switches to execution.
 */
const planExecute: FlowVariant = {
  id: 'plan-execute',
  summary: 'forced plan artifact first, then execution against it',
  maxSteps: 28,
  buildPrompt: () => `Instructions:

You are a research assistant. This turn has two phases.

PHASE 1 — PLAN. Your first action is todoWrite. Break the question into the smallest set of independently answerable parts (usually 2-5; use 1 for a simple question). Each item names a concrete thing to find out, not a tool to call.

PHASE 2 — EXECUTE. Work the list in order. Mark each item done as you close it. When every item is done, write the answer.
${GROUNDING_CONTRACT}
${SILENT_EXECUTION}
${CITATION_RULES}
${OUTPUT_RULES}`,
  prepareStep: ({ stepNumber }) =>
    stepNumber === 0
      ? { toolChoice: { type: 'tool', toolName: 'todoWrite' } }
      : {
          system: `Execute your plan. Take the next unfinished item, make the one tool call that closes it, and mark it done. Some items need no tool — answer those from knowledge and move on. When every item is done, write the final answer starting with "## ".
${GROUNDING_CONTRACT}
${SILENT_EXECUTION}
${CITATION_RULES}
${OUTPUT_RULES}`
        },
  stepStatus: ({ stepNumber, steps }) =>
    stepNumber === 0
      ? 'Planning the research'
      : `Working the plan — step ${stepNumber}, ${countToolCalls(steps)} tool call${countToolCalls(steps) === 1 ? '' : 's'} so far`
}

/**
 * E — retrieve once, wide, then reason.
 *
 * The opposite bet to C: one deep retrieval, then NO further tools, forcing
 * the model to reason over what it has instead of iterating. Tests whether
 * iteration is earning its cost, given each extra step measured ~7s of model
 * round trip on this deployment.
 *
 * Step 0 forces search; from step 1 the tool set is emptied, which makes the
 * loop terminate naturally at step 1 since a step with no tool calls ends the
 * turn. That is the mechanism, not a side effect.
 */
const wideOnce: FlowVariant = {
  id: 'wide-once',
  summary: 'one forced deep search, then answer with no further tools',
  maxSteps: 4,
  buildPrompt: () => `Instructions:

You are a research assistant. You get exactly ONE search, then you answer.

- Your single search must be the best possible query for this question: specific, keyword-dense, and covering the whole question rather than one facet.
- After it returns you will have no further tools. Reason over what you have and write the answer.
- If the results only partially cover the question, answer what they support and state plainly what could not be verified. Do not guess to fill a gap.
${CITATION_RULES}
${OUTPUT_RULES}`,
  prepareStep: ({ stepNumber }) =>
    stepNumber === 0
      ? { toolChoice: { type: 'tool', toolName: 'search' } }
      : {
          activeTools: [],
          toolChoice: 'none',
          system: `You have all the material you will get. Write the final answer now, starting with "## ". Use only what the search returned; state plainly anything it did not cover.
${CITATION_RULES}
${OUTPUT_RULES}`
        },
  stepStatus: ({ stepNumber }) =>
    stepNumber === 0 ? 'Composing one deep search' : 'Reasoning over results'
}

/**
 * F — question-side router, decision BINDING in code.
 *
 * The arm the adaptive-retrieval literature actually supports, and the direct
 * counterpart to `adaptive`.
 *
 * `adaptive` asks the model to decide whether it needs to search. The
 * published evidence says that is close to worthless: SKR (EMNLP 2023) got
 * +0.03 points from directly prompting the model over always retrieving;
 * verbalized confidence has AUROC ~0.63 (Xiong et al.); and When2Tool found
 * suppression prompts cut tool calls INDISCRIMINATELY, costing -34.7 accuracy
 * points on hard tasks. Anthropic's own docs draw the line explicitly: a
 * prompt makes search more or less likely, only a parameter makes it certain.
 *
 * So this arm does the opposite. It keeps the existing cheap classifier — a
 * judgement about the QUESTION (is this knowledge-intensive? time-sensitive?),
 * which UAR measured at 86-92% accuracy, versus 72% for the model's
 * self-knowledge — and makes that verdict BINDING:
 *
 *   skipSearch  -> search and fetch are removed from the tool set entirely
 *   otherwise   -> step 0 is forced to search
 *
 * Note the measured caveat: on this provider toolChoice behaves as a strong
 * hint rather than a guarantee (a forced todoWrite fired on a complex question
 * and not on a trivial one), so "binding" is stronger than prompting but not
 * absolute. Removing the tool is the half that IS absolute.
 *
 * Bias deliberately favours searching. The asymmetry is documented in both
 * directions: over-retrieval costs accuracy on ~10% of questions plus latency,
 * while under-retrieval costs ~47 points on time-sensitive questions and
 * produces confidently stale answers the user cannot detect.
 */
const router: FlowVariant = {
  id: 'router',
  summary:
    'classifier decides on question properties; decision enforced in code',
  maxSteps: 20,
  buildPrompt: () => `Instructions:

You are a research assistant.

If you have search tools available, the routing layer has already determined this question needs current or citable sources: use them. Search first, then answer.

If you have no search tools, the routing layer determined this question is answerable from your own knowledge. Answer directly and say plainly that you did so without searching. Do not invent citations.

- Read a promising page in full with fetch rather than re-searching for depth. Pass an array of urls to fetch several at once.
- Search again only when the results left a specific gap you can name.
${SILENT_EXECUTION}
${CITATION_RULES}
${OUTPUT_RULES}`,
  prepareStep: ({ stepNumber, skipSearch }) => {
    if (skipSearch) {
      // Removing the tools is the enforcement. A prompt saying "do not search"
      // is exactly the indiscriminate-suppression failure mode.
      return {
        activeTools: ['calculate', 'get_weather', 'remember', 'recall']
      }
    }
    return stepNumber === 0
      ? { toolChoice: { type: 'tool', toolName: 'search' } }
      : {}
  },
  stepStatus: ({ stepNumber, skipSearch }) =>
    stepNumber === 0
      ? skipSearch
        ? 'Answering from existing knowledge'
        : 'Searching for sources'
      : null
}

export const FLOW_VARIANTS: Record<string, FlowVariant> = {
  baseline,
  adaptive,
  'react-gap': reactGap,
  'plan-execute': planExecute,
  'wide-once': wideOnce,
  router
}

export const DEFAULT_FLOW_VARIANT = 'baseline'

/** Resolve FLOW_VARIANT, falling back to baseline for an unknown value. */
export function resolveFlowVariant(raw?: string): FlowVariant {
  const key = (raw ?? '').trim()
  if (key && FLOW_VARIANTS[key]) return FLOW_VARIANTS[key]
  if (key && key !== DEFAULT_FLOW_VARIANT) {
    console.warn(
      `[flow] unknown FLOW_VARIANT "${key}", falling back to ${DEFAULT_FLOW_VARIANT}`
    )
  }
  return FLOW_VARIANTS[DEFAULT_FLOW_VARIANT]
}
