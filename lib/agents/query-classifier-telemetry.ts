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

// The classification itself, not just its cost. Omitted when the call failed
// or came back empty (there is no decision to report then).
//
// This line used to carry only timings, so the only way to ask "what did the
// classifier decide" was to infer it from downstream behaviour. That inference
// was made once, against a run whose downstream telemetry was itself wrong,
// and concluded needsRecent was true on all 16 probes when the same run's logs
// show the gate declining on 9 of them. Decisions are cheap to log and
// expensive to reconstruct.
//
// needsRecent and needsSources are both reported because the pipeline's
// injection gate is `!skipSearch && (needsRecent || needsSources)` — logging
// only one of them leaves it ambiguous which signal opened the gate, which is
// exactly the reconstruction this line exists to make unnecessary.
export type ClassifierDecision = {
  skipSearch: boolean
  needsRecent: boolean
  needsSources: boolean
  intent: string
  // The retrieval plan, logged as SIZE plus the queries themselves. Size alone
  // cannot answer the question this field exists to settle — whether an upfront
  // plan decomposes a question the way the model does at runtime — because that
  // needs the actual queries to compare against the searches a turn issued.
  // Both are cheap: a plan is at most 8 short strings.
  subQuestions?: string[]
}

export type ClassifierTelemetry = {
  totalMs: number
  modelMs: number
  inputTokens?: number
  outputTokens?: number
  model: string
  outcome: 'ok' | 'failed' | 'empty'
  decision?: ClassifierDecision
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
    outcome: t.outcome,
    ...(t.decision && {
      skip_search: t.decision.skipSearch,
      needs_recent: t.decision.needsRecent,
      needs_sources: t.decision.needsSources,
      intent: t.decision.intent,
      ...(t.decision.subQuestions && {
        plan_size: t.decision.subQuestions.length,
        // Saturation means the cap is shaping the plan rather than the
        // question shaping it — the plan is then a floor, not a measurement.
        ...(t.decision.subQuestions.length >= 8 && { plan_saturated: true }),
        plan: t.decision.subQuestions
      })
    })
  })}`
}
