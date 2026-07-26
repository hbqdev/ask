// Whether Ollama models reason before answering.
//
// Lives in its own module because BOTH call sites need it and registry.ts
// cannot import model-selection.ts (model-selection imports registry).
//
// Only registry.ts's setting is load-bearing. ai-sdk-ollama reads `think` from
// MODEL-level settings — `provider(modelId, { think })` — and never from the
// AI SDK's call-level providerOptions, so the `providerOptions.ollama.think`
// in model-selection.ts has never had any effect. Verified by reading the
// library: it branches on `this.settings.think`.
//
// Why this matters: measured on prod, a 131.7s turn spent 85.4s between the
// search finishing and the first word, with ONE reasoning block of 38,684
// characters against an 8,730-character answer. A direct probe of
// kimi-k2.6:cloud confirms the cloud proxy DOES honour the parameter —
// think:false returned 0 chars of thinking in 3.8s versus 1,667 chars in 6.6s
// by default — so this is controllable, it just was not being controlled.
//
// Defaults ON: only the exact string 'false' disables it, so a typo cannot
// silently change answer quality.
export function thinkEnabledForOllama(): boolean {
  return process.env.OLLAMA_THINK !== 'false'
}
