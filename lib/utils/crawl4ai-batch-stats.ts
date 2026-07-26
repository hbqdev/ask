// Per-chunk shape of a crawl batch, for the [latency:search] line.
//
// crawl_ms is the largest and most variable stage measured (9.4s to 111s on
// staging) and it dominates every other stage, but one number cannot say why.
// Chunks run concurrently, so a batch is either:
//
//   tail-bound       median chunk fast, slowest chunk far above it — one
//                    pathological page holds up a batch that was otherwise
//                    finished. Fix: tighter per-chunk timeout.
//   throughput-bound median chunk close to slowest — everything is slow.
//                    Fix: more concurrency, smaller chunks, or fewer pages.
//
// Those have opposite remedies, so the distinction has to be measurable
// before anything is tuned.

export type Crawl4aiBatchStats = {
  chunks: number
  chunk_failures: number
  slowest_chunk_ms: number
  median_chunk_ms: number
}

export function summariseChunkDurations(
  durationsMs: number[],
  failures: number
): Crawl4aiBatchStats {
  if (durationsMs.length === 0) {
    return {
      chunks: 0,
      chunk_failures: 0,
      slowest_chunk_ms: 0,
      median_chunk_ms: 0
    }
  }
  const sorted = [...durationsMs].sort((a, b) => a - b)
  return {
    chunks: durationsMs.length,
    chunk_failures: failures,
    slowest_chunk_ms: Math.round(sorted[sorted.length - 1]),
    // Upper-middle on an even count, matching the convention used in the
    // analysis scripts these numbers get read with.
    median_chunk_ms: Math.round(sorted[Math.floor(sorted.length / 2)])
  }
}
