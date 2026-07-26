import { describe, expect, it } from 'vitest'

import { buildRerankTelemetry } from '../rerank-telemetry'

// rerank_ms is 6.5-7.6s and is now the largest local stage, but the single
// number cannot say whether that is per-passage compute, a fixed per-call
// cost, or a cold GPU. Those have different fixes, and the classifier turned
// out to be the third of those (a ~3.9s wake-up on an idle P5000, invisible
// until it was split out).
describe('buildRerankTelemetry', () => {
  it('reports throughput so per-passage cost is separable from fixed cost', () => {
    const line = buildRerankTelemetry({
      passages: 264,
      wallMs: 6600,
      tier: 'cross-encoder'
    })
    const obj = JSON.parse(line.slice('[latency:rerank] '.length))
    expect(obj).toMatchObject({
      passages: 264,
      wall_ms: 6600,
      tier: 'cross-encoder',
      passages_per_s: 40
    })
  })

  it('reports per-passage cost, which is the number that should be flat', () => {
    // If ms_per_passage falls as passages rise, the call is dominated by a
    // FIXED cost (queue, model load, GPU wake) rather than by the work.
    const line = buildRerankTelemetry({
      passages: 100,
      wallMs: 5000,
      tier: 'cross-encoder'
    })
    const obj = JSON.parse(line.slice('[latency:rerank] '.length))
    expect(obj.ms_per_passage).toBe(50)
  })

  it('handles a zero-passage call without dividing by zero', () => {
    const line = buildRerankTelemetry({
      passages: 0,
      wallMs: 12,
      tier: 'cross-encoder'
    })
    const obj = JSON.parse(line.slice('[latency:rerank] '.length))
    expect(obj.passages_per_s).toBe(0)
    expect(obj.ms_per_passage).toBe(0)
  })

  it('records the tier, so a silent fallback is visible', () => {
    // A cross-encoder outage degrades to the bi-encoder and the turn just
    // looks different, with nothing saying why.
    const line = buildRerankTelemetry({
      passages: 50,
      wallMs: 900,
      tier: 'embedding'
    })
    expect(JSON.parse(line.slice('[latency:rerank] '.length)).tier).toBe(
      'embedding'
    )
  })

  it('records a failed call rather than leaving it invisible', () => {
    const line = buildRerankTelemetry({
      passages: 264,
      wallMs: 20000,
      tier: 'cross-encoder',
      failed: true
    })
    expect(JSON.parse(line.slice('[latency:rerank] '.length)).failed).toBe(true)
  })

  it('omits the failed flag on a healthy call', () => {
    const line = buildRerankTelemetry({
      passages: 10,
      wallMs: 100,
      tier: 'cross-encoder'
    })
    expect(
      JSON.parse(line.slice('[latency:rerank] '.length))
    ).not.toHaveProperty('failed')
  })

  it('prefixes the line so it groups with the other latency lines', () => {
    const line = buildRerankTelemetry({
      passages: 1,
      wallMs: 1,
      tier: 'cross-encoder'
    })
    expect(line.startsWith('[latency:rerank] {')).toBe(true)
  })
})
