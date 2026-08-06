import { splitText } from '../embeddings/split-text'
import {
  cosineSimilarity,
  type EmbeddingModelId,
  embedTexts
} from '../embeddings/transformers-embedding'

// Shadow-only crop-position measurement.
//
// The 10k crop discards ~82% of crawled text, but most of a 24k-317k-char page
// is nav/boilerplate/footers — so raw page length can't say whether the crop is
// dropping SIGNAL or noise. This answers exactly that: for each source the
// answer model reads, it finds where that page's MOST query-relevant passage
// sits in the FULL (uncropped) page, and whether that passage survived the crop
// or was thrown away past it. tail_frac is the headline — the fraction of read
// sources whose best content the crop discarded.
//
// v2: the [crop-pos] line also carries chatId + per-source detail (url, offset,
// tail) so it can be joined offline against the [cite-urls] line (which sources
// the answer actually cited) to get the CITATION-scoped number — the truer cost,
// since the model reads ~20 sources but cites only a few.
//
// It NEVER changes the answer (the crop still governs what the model reads) and
// runs off the response path via after(), so it adds no user-facing latency.
// It must never throw: a measurement cannot be allowed to break a turn.

const CROP_CHARS = 10000
// The cheap bi-encoder (same model the rerank fallback uses). "Roughly where is
// the relevant content" doesn't need cross-encoder precision; it needs to be cheap.
const MODEL: EmbeddingModelId = 'Xenova/all-MiniLM-L6-v2'
const PASSAGE_MAX_TOKENS = 256
const PASSAGE_OVERLAP_TOKENS = 32

export type CropPositionSource = { url: string; rawContent: string }

/** Per-source detail (short keys — this rides in a log line). */
export type CropPositionDetail = { u: string; o: number; t: 0 | 1 }

export type CropPositionStat = {
  sources: number
  /** Read sources whose most-relevant passage started past the crop. */
  best_in_tail: number
  tail_frac: number
  p50_offset: number
  p90_offset: number
  max_offset: number
  crop: number
  detail: CropPositionDetail[]
}

/** Pure computation, separated from logging so it can be unit-tested. */
export async function computeCropPositions(
  query: string,
  sources: CropPositionSource[]
): Promise<CropPositionStat | null> {
  const offsets: number[] = []
  const detail: CropPositionDetail[] = []
  let bestInTail = 0
  for (const src of sources) {
    const passages = splitText(
      src.rawContent,
      PASSAGE_MAX_TOKENS,
      PASSAGE_OVERLAP_TOKENS
    )
    if (passages.length === 0) continue
    const vectors = await embedTexts([query, ...passages], MODEL)
    const q = vectors[0]
    let bestIdx = 0
    let bestScore = -Infinity
    for (let i = 0; i < passages.length; i++) {
      const s = cosineSimilarity(q, vectors[i + 1])
      if (s > bestScore) {
        bestScore = s
        bestIdx = i
      }
    }
    // Estimate the winning passage's char offset from its fractional position
    // in the (roughly uniform) passage list. Robust to repeated content —
    // indexOf on the overlapped prefix finds the first occurrence, not the real
    // one — and monotonic, which is all head-vs-tail classification needs.
    const offset = Math.round(
      (bestIdx / passages.length) * src.rawContent.length
    )
    const tail: 0 | 1 = offset >= CROP_CHARS ? 1 : 0
    offsets.push(offset)
    detail.push({ u: src.url, o: offset, t: tail })
    if (tail) bestInTail++
  }
  if (offsets.length === 0) return null
  const sorted = [...offsets].sort((a, b) => a - b)
  const pct = (f: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))]
  return {
    sources: offsets.length,
    best_in_tail: bestInTail,
    tail_frac: Math.round((bestInTail / offsets.length) * 100) / 100,
    p50_offset: pct(0.5),
    p90_offset: pct(0.9),
    max_offset: sorted[sorted.length - 1],
    crop: CROP_CHARS,
    detail
  }
}

/** Fire-and-forget wrapper: compute, log one line, swallow everything. */
export async function measureCropPositions(
  query: string,
  sources: CropPositionSource[],
  chatId?: string
): Promise<void> {
  try {
    const stat = await computeCropPositions(query, sources)
    if (stat) console.log(`[crop-pos] ${JSON.stringify({ chatId, ...stat })}`)
  } catch {
    // A shadow measurement must never break a turn.
  }
}
