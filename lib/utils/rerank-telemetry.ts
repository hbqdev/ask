// One structured line per rerank call.
//
// rerank_ms is 6.5-7.6s and, with crawl now bounded by remote-site tail
// latency and the classifier down to ~2s, it is the largest stage still under
// our control. The single number cannot distinguish:
//
//   per-passage compute   ms_per_passage flat as passages rise
//   fixed per-call cost   ms_per_passage falls sharply as passages rise
//                         (queueing, model load, or a GPU waking from idle)
//
// That distinction matters because the fixes are opposite — fewer/shorter
// passages versus keeping the GPU warm — and the classifier turned out to be
// the second kind: a ~3.9s wake-up on an idle P5000 that was invisible until
// model time was split from total time.

export type RerankTelemetry = {
  passages: number
  wallMs: number
  tier: 'cross-encoder' | 'embedding' | 'keyword'
  failed?: boolean
}

export function buildRerankTelemetry(t: RerankTelemetry): string {
  const seconds = t.wallMs / 1000
  return `[latency:rerank] ${JSON.stringify({
    passages: t.passages,
    wall_ms: Math.round(t.wallMs),
    passages_per_s:
      t.passages > 0 && seconds > 0 ? Math.round(t.passages / seconds) : 0,
    ms_per_passage: t.passages > 0 ? Math.round(t.wallMs / t.passages) : 0,
    tier: t.tier,
    ...(t.failed && { failed: true })
  })}`
}
