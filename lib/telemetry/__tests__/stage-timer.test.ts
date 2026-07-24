import { describe, expect, it } from 'vitest'

import { StageTimer } from '../stage-timer'

// Deterministic clock: each call returns the next queued value.
function fakeClock(values: number[]): () => number {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

function parse(line: string, tag: string) {
  expect(line.startsWith(`[${tag}] `)).toBe(true)
  return JSON.parse(line.slice(`[${tag}] `.length))
}

describe('StageTimer', () => {
  it('times a stage and emits one tagged line with the duration and total', async () => {
    const lines: string[] = []
    // start=0, stage start=10, stage end=150, emit=200
    const t = new StageTimer(
      'latency:search',
      { depth: 'advanced' },
      fakeClock([0, 10, 150, 200]),
      l => lines.push(l)
    )

    const result = await t.time('crawl_ms', async () => 'pages')
    t.emit()

    expect(result).toBe('pages')
    expect(lines).toHaveLength(1)
    expect(parse(lines[0], 'latency:search')).toMatchObject({
      depth: 'advanced',
      crawl_ms: 140,
      total_ms: 200
    })
  })

  it('records counts alongside durations', async () => {
    const lines: string[] = []
    const t = new StageTimer('latency:search', {}, fakeClock([0, 100]), l =>
      lines.push(l)
    )

    t.set('candidates', 32)
    t.set('crawled', 16)
    t.emit()

    expect(parse(lines[0], 'latency:search')).toMatchObject({
      candidates: 32,
      crawled: 16
    })
  })

  it('still records the duration when a stage throws, and rethrows', async () => {
    const lines: string[] = []
    const t = new StageTimer(
      'latency:search',
      {},
      fakeClock([0, 10, 90, 120]),
      l => lines.push(l)
    )

    await expect(
      t.time('rerank_ms', async () => {
        throw new Error('reranker down')
      })
    ).rejects.toThrow('reranker down')
    t.emit()

    // A stage that fails is exactly the one worth seeing in the numbers.
    expect(parse(lines[0], 'latency:search')).toMatchObject({ rerank_ms: 80 })
  })

  it('never lets a failing sink break the caller', async () => {
    const t = new StageTimer('latency:search', {}, fakeClock([0, 1]), () => {
      throw new Error('sink exploded')
    })
    expect(() => t.emit()).not.toThrow()
  })
})
