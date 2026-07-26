import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// crawl_ms ranges 9.4s to 111s on staging and that variance dominates every
// other stage, but the single number cannot say WHY. Chunks run concurrently
// (CRAWL4AI_MAX_CONCURRENT_CHUNKS, default 6), so the batch is either
// tail-bound — one pathological chunk while the rest finished long ago — or
// throughput-bound, where every chunk is slow. Those have opposite fixes:
// a tighter per-chunk timeout versus more concurrency or smaller chunks.
// Per-chunk timings distinguish them.
import { summariseChunkDurations } from '../crawl4ai-batch-stats'

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('summariseChunkDurations', () => {
  it('reports the slowest chunk, which is what the caller actually waits for', () => {
    const s = summariseChunkDurations([1000, 9000, 1200], 0)
    expect(s.slowest_chunk_ms).toBe(9000)
  })

  it('reports the median so a lone outlier is visible against the rest', () => {
    // Tail-bound looks like this: median far below slowest.
    const s = summariseChunkDurations([1000, 1100, 1200, 40000], 0)
    expect(s.median_chunk_ms).toBe(1200)
    expect(s.slowest_chunk_ms).toBe(40000)
  })

  it('counts the chunks so cost per chunk can be derived', () => {
    expect(summariseChunkDurations([500, 600, 700], 0).chunks).toBe(3)
  })

  it('carries the failure count — an aborted chunk discards all its pages', () => {
    expect(summariseChunkDurations([500, 600], 2).chunk_failures).toBe(2)
  })

  it('handles a single chunk without pretending there is a distribution', () => {
    const s = summariseChunkDurations([4200], 0)
    expect(s.chunks).toBe(1)
    expect(s.slowest_chunk_ms).toBe(4200)
    expect(s.median_chunk_ms).toBe(4200)
  })

  it('returns zeroed stats for an empty batch rather than NaN', () => {
    const s = summariseChunkDurations([], 0)
    expect(s).toEqual({
      chunks: 0,
      chunk_failures: 0,
      slowest_chunk_ms: 0,
      median_chunk_ms: 0
    })
  })

  it('rounds to whole milliseconds so the log line stays readable', () => {
    const s = summariseChunkDurations([1000.4, 2000.6], 0)
    expect(Number.isInteger(s.slowest_chunk_ms)).toBe(true)
    expect(Number.isInteger(s.median_chunk_ms)).toBe(true)
  })
})
