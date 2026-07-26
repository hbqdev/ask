// Turns a document's kept passages into the single content string that goes
// to the answering model.
//
// Why a separate module: the search route is a long handler that needs a live
// SearXNG, a crawler and a reranker to exercise. Ordering, gap detection and
// the empty case are exactly the logic most likely to be subtly wrong, so
// they live here where they are testable in isolation.

import type { RankedPassage } from '../embeddings/rerank'

/** Signals to the model that text was omitted between two passages. */
const ELISION = '[…]'

/**
 * Join passages in document order, inserting an elision marker only where
 * their indices actually skip. Adjacent passages are contiguous text and are
 * joined as continuous prose.
 *
 * Returns `fallback` when there is nothing usable to join, so a document that
 * produced no passages keeps its original content instead of going empty.
 */
export function buildExcerptContent(
  passages: RankedPassage[],
  fallback: string
): string {
  const usable = passages
    // `filter` returns a fresh array, so the sort below cannot reorder the
    // caller's `topPassages` under it.
    .filter(p => p.text.trim().length > 0)
    // Defensive: correctness here must not depend on the caller's ordering.
    .sort((a, b) => a.index - b.index)

  if (usable.length === 0) return fallback

  let out = usable[0].text
  for (let i = 1; i < usable.length; i++) {
    const gap = usable[i].index - usable[i - 1].index > 1
    out += (gap ? `\n${ELISION}\n` : '\n') + usable[i].text
  }
  return out
}
