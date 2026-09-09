// Whether — and how hard — Ollama models reason before answering.
//
// Lives in its own module because BOTH call sites need it and registry.ts
// cannot import model-selection.ts (model-selection imports registry).
//
// Only registry.ts's setting is load-bearing. ai-sdk-ollama reads `think` from
// MODEL-level settings — `provider(modelId, { think })` — and never from the
// AI SDK's call-level providerOptions, so the `providerOptions.ollama.think`
// in model-selection.ts has never had any effect. Verified by reading the
// library: it branches on `this.settings.think` and forwards it verbatim into
// the Ollama chat request (`think: this.settings.think`). The underlying
// `ollama` client types `think` as `boolean | 'high' | 'medium' | 'low'`, so
// an effort LEVEL — not just on/off — reaches the model.
//
// Why this matters: measured on prod, a 131.7s turn spent 85.4s between the
// search finishing and the first word, with ONE reasoning block of 38,684
// characters against an 8,730-character answer. That deliberation is the single
// largest remaining latency source and it is paid on EVERY turn, factual lookup
// and deep synthesis alike. A direct probe of kimi-k2.6:cloud confirms the
// cloud proxy DOES honour the parameter — think:false returned 0 chars of
// thinking in 3.8s versus 1,667 chars in 6.6s by default — so this is
// controllable, it just was not being controlled.
//
// The control is MODEL-AGNOSTIC: it is applied to whatever chat model the user
// picks, in registry.ts where the answering model is instantiated, so it dials
// the SAME model's reasoning down rather than switching models.

/**
 * What `think` value to hand ai-sdk-ollama for the answering model.
 * `false` disables reasoning; the three strings request a reduced effort level
 * on models that support graded reasoning (gpt-oss-style); `true` is full
 * reasoning (today's behaviour).
 */
export type AnswerThink = boolean | 'low' | 'medium' | 'high'

// The shipped default when neither ANSWER_THINK nor the legacy OLLAMA_THINK is
// set. Chosen from the 2026-09-09 lab A/B: graded effort ('low'/'medium'/'high')
// is a NO-OP on the fleet's cloud models (deepseek/kimi/minimax etc. — only
// gpt-oss honours levels; any truthy string = full reasoning). Only `false`
// (think off) actually cuts the answering model's reasoning — measured -13% to
// -42% completion tokens with answer quality holding on hard multi-step
// questions (incl. the Swallowed Star worldbuilding case). Env-overridable per
// deployment (ANSWER_THINK=on|low|off) so a container restart can move it
// without a code change; set ANSWER_THINK=on to restore full reasoning.
export const ANSWER_THINK_DEFAULT: AnswerThink = false

// Parse a raw ANSWER_THINK value into an AnswerThink, or undefined when the
// value is absent/blank (so the caller can fall through to the legacy knob).
function parseAnswerThink(raw: string | undefined): AnswerThink | undefined {
  const v = (raw ?? '').trim().toLowerCase()
  if (!v) return undefined
  switch (v) {
    case 'off':
    case 'false':
    case 'no':
    case 'none':
    case 'disable':
    case 'disabled':
    case '0':
      return false
    case 'low':
    case 'min':
    case 'minimal':
      return 'low'
    case 'medium':
    case 'med':
      return 'medium'
    case 'high':
    case 'full':
    case 'max':
      return 'high'
    case 'on':
    case 'true':
    case 'yes':
    case 'enable':
    case 'enabled':
    case '1':
      return true
    default:
      // Unknown value: default ON rather than silently changing answer
      // quality on a typo — matches the legacy knob's fail-safe stance.
      return true
  }
}

/**
 * The reasoning control for the ANSWERING model, resolved per request.
 *
 * Precedence:
 *   1. ANSWER_THINK — the model-agnostic reasoning knob (off | low | medium |
 *      high | on, plus common aliases). This is the primary control.
 *   2. OLLAMA_THINK — the legacy boolean (only the exact string 'false'
 *      disables), honoured for back-compat when ANSWER_THINK is unset.
 *   3. ANSWER_THINK_DEFAULT — the shipped code default.
 *
 * Read fresh on every call (not hoisted to module scope) so a container-env
 * change takes effect on the next turn without a process restart.
 */
export function resolveAnswerThink(): AnswerThink {
  const parsed = parseAnswerThink(process.env.ANSWER_THINK)
  if (parsed !== undefined) return parsed

  // Legacy fallback: OLLAMA_THINK=false disables; anything else is on.
  if (process.env.OLLAMA_THINK !== undefined) {
    return process.env.OLLAMA_THINK !== 'false'
  }

  return ANSWER_THINK_DEFAULT
}

/**
 * Boolean view of the resolved control — true whenever reasoning is enabled at
 * ALL (full or a reduced level), false only when disabled. Kept because the
 * providerOptions bookkeeping in model-selection.ts / default-model.ts is
 * boolean-shaped (and is itself a no-op — see the header); this keeps it from
 * disagreeing with the load-bearing registry.ts setting.
 */
export function thinkEnabledForOllama(): boolean {
  return Boolean(resolveAnswerThink())
}
