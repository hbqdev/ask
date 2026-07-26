import { describe, expect, it } from 'vitest'

import { buildClassifierTelemetry } from '../query-classifier-telemetry'

// classify_ms measures 9.0s with a warm GPU, but a direct equivalent call to
// the same model is 6.9s wall, of which only 0.21s is prompt eval and 2.36s is
// generation. Roughly 6s is unaccounted, and every time this session tried to
// reason forward from a plausible mechanism it was wrong. This makes the model
// call's own cost readable so the remainder is attributable rather than
// guessed at.
describe('buildClassifierTelemetry', () => {
  it('reports the model call cost and the overhead around it', () => {
    const line = buildClassifierTelemetry({
      totalMs: 9000,
      modelMs: 6870,
      inputTokens: 929,
      outputTokens: 52,
      model: 'granite4.1:8b',
      outcome: 'ok'
    })
    const obj = JSON.parse(line.slice('[latency:classify] '.length))
    expect(obj).toMatchObject({
      total_ms: 9000,
      model_ms: 6870,
      // The number that matters: time inside classifyQuery that was NOT the
      // model call.
      overhead_ms: 2130,
      prompt_tokens: 929,
      gen_tokens: 52,
      model: 'granite4.1:8b',
      outcome: 'ok'
    })
  })

  it('derives generation rate, which is the local hardware constraint', () => {
    // Measured: 22-24 tok/s on the P5000. Emitting it makes a model or host
    // swap immediately comparable.
    const line = buildClassifierTelemetry({
      totalMs: 5000,
      modelMs: 4000,
      inputTokens: 900,
      outputTokens: 100,
      model: 'granite4.1:8b',
      outcome: 'ok'
    })
    const obj = JSON.parse(line.slice('[latency:classify] '.length))
    expect(obj.gen_tok_per_s).toBe(25)
  })

  it('never emits a negative overhead when the clock disagrees', () => {
    const line = buildClassifierTelemetry({
      totalMs: 100,
      modelMs: 120,
      model: 'granite4.1:8b',
      outcome: 'ok'
    })
    const obj = JSON.parse(line.slice('[latency:classify] '.length))
    expect(obj.overhead_ms).toBe(0)
  })

  it('omits token fields when usage was not reported', () => {
    const line = buildClassifierTelemetry({
      totalMs: 5000,
      modelMs: 4000,
      model: 'granite4.1:8b',
      outcome: 'ok'
    })
    const obj = JSON.parse(line.slice('[latency:classify] '.length))
    expect(obj).not.toHaveProperty('prompt_tokens')
    expect(obj).not.toHaveProperty('gen_tokens')
    expect(obj).not.toHaveProperty('gen_tok_per_s')
  })

  it('records a failed classification, which is otherwise invisible', () => {
    // A classifier failure silently falls back to always-search. Without this
    // the turn just looks slow.
    const line = buildClassifierTelemetry({
      totalMs: 12000,
      modelMs: 12000,
      model: 'granite4.1:8b',
      outcome: 'failed'
    })
    expect(JSON.parse(line.slice('[latency:classify] '.length)).outcome).toBe(
      'failed'
    )
  })

  it('prefixes the line so it groups with the other latency lines', () => {
    const line = buildClassifierTelemetry({
      totalMs: 1,
      modelMs: 1,
      model: 'm',
      outcome: 'ok'
    })
    expect(line.startsWith('[latency:classify] {')).toBe(true)
  })
})
