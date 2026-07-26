// Bounds the total passages sent to the reranker in one call.
//
// Relaxing the quality gate took usable docs from 18 to 50, and the
// cross-encoder from 195 passages (8.3s) to 499 (20.0s) — exactly its 20s
// timeout. The call failed and the turn degraded silently to the weaker
// bi-encoder, which is a quality regression that looked like a latency one.
//
// Cost is linear at a measured ~40ms/passage (24-25 passages/sec), so a total
// budget bounds rerank time predictably.
//
// This trims passages PER DOC and never the doc list: every document keeps at
// least one passage, so it still receives a score and can still be returned.
// Sources are preserved; only the depth of evidence per source shrinks, and
// only when there are many sources to begin with.

/** ~40ms/passage measured, so 320 keeps a call near 13s — inside the 20s cap. */
const DEFAULT_BUDGET = 320

export function passagesPerDocForBudget(
  docCount: number,
  maxPerDoc: number
): number {
  if (docCount <= 0) return maxPerDoc
  const raw = Number(process.env.RERANK_PASSAGE_BUDGET)
  const budget = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET
  // At least 1: a doc with no passages gets no score and vanishes.
  return Math.max(1, Math.min(maxPerDoc, Math.floor(budget / docCount)))
}
