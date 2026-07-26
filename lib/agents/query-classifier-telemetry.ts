// One structured line per classification.
//
// classify_ms sits at 9.0s even with a warm GPU, while a direct call to the
// same model with the same prompt and schema is 6.9s wall — of which only
// 0.21s is prompt eval and 2.36s is generation. Roughly 6s was unattributable,
// and guessing at it has a poor record: every mechanism proposed from first
// principles this session turned out to be wrong, while every real cause was
// found by adding a mark and reading it.
//
// So this splits the classifier into the model call and everything around it,
// and reports generation rate — the constraint on local hardware, measured at
// 22-24 tok/s on the P5000 — so a model or host swap is directly comparable.

export type ClassifierTelemetry = {
  totalMs: number
  modelMs: number
  inputTokens?: number
  outputTokens?: number
  model: string
  outcome: 'ok' | 'failed' | 'empty'
}

export function buildClassifierTelemetry(t: ClassifierTelemetry): string {
  const hasTokens =
    typeof t.inputTokens === 'number' && typeof t.outputTokens === 'number'
  const genSeconds = t.modelMs / 1000
  return `[latency:classify] ${JSON.stringify({
    total_ms: Math.round(t.totalMs),
    model_ms: Math.round(t.modelMs),
    // Time inside classifyQuery that was not the model call. This is the
    // number the whole line exists to expose.
    overhead_ms: Math.max(0, Math.round(t.totalMs - t.modelMs)),
    ...(hasTokens && {
      prompt_tokens: t.inputTokens,
      gen_tokens: t.outputTokens,
      ...(genSeconds > 0 && {
        gen_tok_per_s: Math.round((t.outputTokens as number) / genSeconds)
      })
    }),
    model: t.model,
    outcome: t.outcome
  })}`
}
