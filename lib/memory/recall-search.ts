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
 * score semantics: cosine when useRerank is false, cross-encoder score once
 * rerank actually runs (below, overwriting the cosine scores). minScore is
 * always a gate on whatever scale `score` currently is: a cosine threshold
 * when useRerank is false, the reranker's threshold when useRerank is true
 * and rerank ran. A caller that asks for useRerank: true but doesn't get a
 * rerank (cross-encoder unconfigured, or crossEncoderScore throws) is left
 * holding a rerank-scale minScore with only cosine scores in hand — cosine
 * and rerank live on unrelated scales (measured: relevant cosine ~0.626 vs
 * irrelevant ~0.570, a band too narrow to gate on; relevant rerank ~0.169 vs
 * irrelevant ~0.0000164), so comparing a rerank-scale threshold against
 * cosine scores would silently pass almost everything. We fail closed
 * instead: return [] rather than everything.
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

    // Track whether rerank actually overwrote scores onto the reranker's
    // scale — "requested" (opts.useRerank) is not the same as "ran": the
    // cross-encoder may be unconfigured, there may be <2 hits to rank, or
    // crossEncoderScore may throw.
    let reranked = false
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
        reranked = true
      } catch {
        // Reranker down — keep the cosine ordering already computed.
      }
    }

    if (opts.minScore !== undefined) {
      // Fail closed: a rerank-scale minScore requested via useRerank: true
      // cannot be honoured if rerank didn't actually run — the scores left
      // in `hits` are still cosine, an unrelated scale (see doc comment
      // above), and comparing the rerank-scale threshold against them would
      // silently let almost everything through. Return nothing rather than
      // everything.
      if (opts.useRerank && !reranked) return []
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
