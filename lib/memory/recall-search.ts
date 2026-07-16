import {
  isRecallEnabled,
  keywordSearchChunks,
  vectorSearchChunks
} from '@/lib/db/recall-actions'
import {
  embedTexts,
  getConfiguredModel
} from '@/lib/embeddings/transformers-embedding'
import {
  crossEncoderScore,
  isCrossEncoderConfigured
} from '@/lib/utils/cross-encoder'

import type { RecallHit, RecallOptions } from './recall-types'

/**
 * The single hybrid retrieval core, shared by the auto-injection, the `recall`
 * tool, and the Library search box. Never throws — every caller degrades to
 * "no recall" rather than failing the turn.
 *
 * score semantics: cosine when useRerank is false, cross-encoder score when
 * rerank ran (step 5 overwrites). minScore is only ever paired with
 * useRerank: false, so it is unambiguously a cosine gate.
 */
export async function recallSearch(
  userId: string,
  query: string,
  opts: RecallOptions
): Promise<RecallHit[]> {
  if (!userId || !query.trim()) return []
  try {
    if (!(await isRecallEnabled(userId))) return []

    // Mirrors upload-rag's CANDIDATE_POOL sizing.
    const pool = Math.max(opts.topK * 3, 30)

    const [queryEmbedding] = await embedTexts([query], getConfiguredModel())

    const [vectorHits, keywordHits] = await Promise.all([
      vectorSearchChunks(userId, queryEmbedding, pool, opts.excludeChatId),
      keywordSearchChunks(userId, query, pool, opts.excludeChatId)
    ])

    // Union, dedup by chunk id — a chunk found by both keeps its cosine score.
    const byId = new Map<string, RecallHit>()
    for (const h of vectorHits) byId.set(h.chunkId, h as RecallHit)
    for (const h of keywordHits) {
      if (!byId.has(h.chunkId)) byId.set(h.chunkId, h as RecallHit)
    }
    let hits = [...byId.values()].sort((a, b) => b.score - a.score)

    if (opts.useRerank && isCrossEncoderConfigured() && hits.length > 1) {
      try {
        const scores = await crossEncoderScore(
          query,
          hits.map(h => h.content),
          // Chunks are 512 tokens — judge the whole chunk, like upload-rag.
          { maxLength: 512, timeoutMs: 10_000 }
        )
        hits = hits
          .map((h, i) => ({ ...h, score: scores[i] ?? 0 }))
          .sort((a, b) => b.score - a.score)
      } catch {
        // Reranker down — keep the cosine ordering already computed.
      }
    }

    if (opts.minScore !== undefined) {
      hits = hits.filter(h => h.score >= opts.minScore!)
    }

    return hits.slice(0, opts.topK)
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('recallSearch failed:', error)
    }
    return []
  }
}
