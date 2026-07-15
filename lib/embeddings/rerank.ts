import { crossEncoderScore } from '../utils/cross-encoder'
import { splitText } from './split-text'
import {
  cosineSimilarity,
  type EmbeddingModelId,
  embedTexts
} from './transformers-embedding'

// Reranking runs on the critical path of EVERY advanced search turn, over
// hundreds of passages. That makes it latency-bound, not quality-bound, so
// it deliberately ignores EMBEDDING_MODEL (which upload-RAG uses, and which
// is set to mxbai-embed-large here for indexing quality).
//
// Benchmarked in-container on 100 passages, CPU:
//   all-MiniLM-L6-v2      199ms
//   mxbai-embed-large-v1 4428ms   (22x slower)
// At ~480 passages/turn that is ~1s vs ~21s — for a job whose only output
// is a relative ordering, where the big model's extra fidelity is not
// worth 20 seconds of the user's time.
const RERANK_MODEL: EmbeddingModelId = 'Xenova/all-MiniLM-L6-v2'

// Passage granularity: small enough that a passage is topically coherent,
// large enough to carry answerable context. Modest overlap keeps sentence
// boundaries from splitting an answer across passages.
const PASSAGE_MAX_TOKENS = 256
const PASSAGE_OVERLAP_TOKENS = 32
// Cap passages per document so one very long page can't dominate the
// embedding batch (CPU inference — batch size is latency).
const MAX_PASSAGES_PER_DOC = 12

export type RerankableDoc = {
  content: string
}

export type RerankedDoc<T> = {
  doc: T
  score: number
  topPassages: string[]
}

/**
 * Shared reranking core: split each doc into passages, score every passage
 * against the query via `scoreFn` (one score per passage, input order),
 * take each doc's best passage as its score, and return the top-K docs.
 * The passage strategy and RerankedDoc shape are identical across rerankers;
 * only how a (query, passage) pair is scored differs.
 */
async function rerankByPassageScorer<T extends RerankableDoc>(
  docs: T[],
  query: string,
  topK: number,
  scoreFn: (query: string, passages: string[]) => Promise<number[]>
): Promise<RerankedDoc<T>[]> {
  if (docs.length === 0) return []

  const passagesPerDoc = docs.map(doc =>
    splitText(doc.content, PASSAGE_MAX_TOKENS, PASSAGE_OVERLAP_TOKENS).slice(
      0,
      MAX_PASSAGES_PER_DOC
    )
  )

  const flatPassages = passagesPerDoc.flat()
  if (flatPassages.length === 0) return []
  const scores = await scoreFn(query, flatPassages)

  let cursor = 0
  const scored: RerankedDoc<T>[] = docs.map((doc, i) => {
    const passages = passagesPerDoc[i]
    const passageScores = passages.map((passage, j) => ({
      passage,
      score: scores[cursor + j] ?? 0
    }))
    cursor += passages.length

    passageScores.sort((a, b) => b.score - a.score)
    return {
      doc,
      score: passageScores[0]?.score ?? 0,
      topPassages: passageScores.slice(0, 3).map(p => p.passage)
    }
  })

  return scored.sort((a, b) => b.score - a.score).slice(0, topK)
}

/**
 * Semantic reranking of crawled documents against the query, using the
 * local transformers embedding pipeline (same one that powers upload
 * RAG — lazily loaded, disk-cached, warm after first use).
 *
 * Each document is split into passages; a document's score is its best
 * passage's cosine similarity to the query. This replaces keyword-count
 * scoring: "how similar is what this page says to what was asked" rather
 * than "how often do the query's words appear".
 *
 * Throws on embedding failure — callers keep the keyword scorer as the
 * fallback so a model/pipeline problem degrades to today's behavior.
 */
export async function rerankByEmbedding<T extends RerankableDoc>(
  docs: T[],
  query: string,
  topK: number
): Promise<RerankedDoc<T>[]> {
  return rerankByPassageScorer(docs, query, topK, async (q, passages) => {
    const vectors = await embedTexts([q, ...passages], RERANK_MODEL)
    const queryVec = vectors[0]
    return vectors.slice(1).map(v => cosineSimilarity(queryVec, v))
  })
}

/**
 * Cross-encoder reranking via the self-hosted reranker service
 * (lib/utils/cross-encoder.ts). Same passage strategy and return shape as
 * rerankByEmbedding, but each (query, passage) pair is scored jointly by a
 * cross-encoder — a stronger relevance signal than comparing
 * separately-embedded vectors. Scores are in [0,1]. Throws if the service
 * call fails, so advanced-search falls back to rerankByEmbedding (which
 * itself falls back to the keyword scorer).
 */
export async function rerankByCrossEncoder<T extends RerankableDoc>(
  docs: T[],
  query: string,
  topK: number
): Promise<RerankedDoc<T>[]> {
  return rerankByPassageScorer(docs, query, topK, crossEncoderScore)
}
