import { describe, expect, it } from 'vitest'

import { LatencyTracker } from '../latency-tracker'

// Deterministic clock: each call returns the next queued value.
function fakeClock(values: number[]): () => number {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

describe('LatencyTracker', () => {
  it('emits one [latency] line with marks, ttft, total, and meta', () => {
    const lines: string[] = []
    // start=0, markFirstToken reads 800, emit reads 1500
    const t = new LatencyTracker(
      { chatId: 'c1', mode: 'balanced' },
      fakeClock([0, 800, 1500]),
      l => lines.push(l)
    )
    t.mark('classify_ms', 120)
    t.mark('recall_ms', 40)
    t.markFirstToken()
    t.emit({ skipSearch: false })

    expect(lines).toHaveLength(1)
    expect(lines[0].startsWith('[latency] ')).toBe(true)
    const obj = JSON.parse(lines[0].slice('[latency] '.length))
    expect(obj).toMatchObject({
      chatId: 'c1',
      mode: 'balanced',
      classify_ms: 120,
      recall_ms: 40,
      ttft_ms: 800,
      total_ms: 1500,
      skipSearch: false
    })
  })

  it('reports ttft_ms null when no token was emitted, and null chatId', () => {
    const lines: string[] = []
    const t = new LatencyTracker(
      { chatId: null, mode: 'speed' },
      fakeClock([0, 900]),
      l => lines.push(l)
    )
    t.emit({ skipSearch: null })
    const obj = JSON.parse(lines[0].slice('[latency] '.length))
    expect(obj.ttft_ms).toBeNull()
    expect(obj.chatId).toBeNull()
    expect(obj.total_ms).toBe(900)
  })

  it('markFirstToken is idempotent (keeps the first stamp)', () => {
    const lines: string[] = []
    const t = new LatencyTracker(
      { chatId: 'c1', mode: 'balanced' },
      fakeClock([0, 500, 999, 2000]),
      l => lines.push(l)
    )
    t.markFirstToken() // reads 500 → firstTokenAt
    t.markFirstToken() // guard short-circuits: no clock read
    t.emit({}) // reads 999 → total_ms
    const obj = JSON.parse(lines[0].slice('[latency] '.length))
    expect(obj.ttft_ms).toBe(500)
    expect(obj.total_ms).toBe(999)
  })
})
