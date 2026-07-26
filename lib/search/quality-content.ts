// Gate deciding whether a crawled page is worth reranking.
//
// This is the largest cut in the pipeline — measured, it drops 42 crawled
// pages to 18 usable, more than half — and it is a word-statistics heuristic
// standing in front of a cross-encoder that scores passages against the actual
// query. The reranker is a far better judge of relevance than a word count;
// this gate only needs to remove pages that are genuinely worthless.
//
// The inherited strict rule rejects two classes of page that are often the
// best answer:
//
//   spec tables      almost no sentence-ending punctuation, so `sentences`
//                    collapses to ~1 and words-per-sentence explodes past 30
//   procedures       short imperative steps, so words-per-sentence falls
//                    below 5
//
// For a hardware-comparison engine the table IS the answer, and it was being
// discarded before the reranker ever saw it.
//
// Relaxing is also cheap now: crawling is bounded by remote-site tail latency
// rather than page count (12 pages 9.1s vs 55 pages 13.1s), and the pages this
// admits are SHORT, so they yield roughly one passage each — about 42ms of
// rerank at the measured 24 passages/sec, not the 12 passages a long page adds.

const ERROR_MARKERS = [
  'Content unavailable due to crawling error',
  'Error fetching content:'
]

/** Below this a page carries no answer regardless of shape. */
const RELAXED_MIN_WORDS = 25

function looksLikeError(text: string): boolean {
  return ERROR_MARKERS.some(marker => text.includes(marker))
}

/**
 * Strict mode is the inherited behaviour, kept as the default so shipping this
 * module changes nothing on its own. `SEARCH_QUALITY_FILTER=relaxed` opts in.
 */
export function isQualityContent(text: string): boolean {
  if (looksLikeError(text)) return false

  const words = text.split(/\s+/).filter(Boolean).length

  if (process.env.SEARCH_QUALITY_FILTER === 'relaxed') {
    // Length only. Shape is the reranker's problem, and it is better at it.
    return words > RELAXED_MIN_WORDS
  }

  const sentences = text.split(/[.!?]+/).length
  const avgWordsPerSentence = words / sentences
  return (
    words > 50 &&
    sentences > 3 &&
    avgWordsPerSentence > 5 &&
    avgWordsPerSentence < 30
  )
}
