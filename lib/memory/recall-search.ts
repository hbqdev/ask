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

/** Passages sent to the cross-encoder per turn. See selectRerankCandidates. */
function rerankPoolSize(): number {
  const n = Number(process.env.RECALL_RERANK_POOL)
  return Number.isFinite(n) && n > 0 ? n : 20
}

/**
 * How many of the pool's slots are held for keyword-only hits — chunks the
 * ILIKE arm found that the vector arm missed.
 */
const KEYWORD_RESERVE = 5

/**
 * Choose which candidates the cross-encoder actually scores.
 *
 * Rerank cost scales with pool size (measured on the live P4000: 3 passages
 * 489ms, 15 976ms, 30 3.4s, 60 7.6s). The two arms return up to `pool` rows
 * EACH, so an uncapped union reranks up to ~60 and spends ~7.6s against a
 * 10s timeout — 2.4s from failing closed, on every turn.
 *
 * Selection is NOT "top N of the union by score". Keyword-only hits carry
 * score 0 by construction (keywordSearchChunks selects a literal 0), so
 * sorting the union by score parks every keyword-only hit at the bottom, and
 * any top-N cut would drop all of them whenever the vector arm alone fills N
 * — which it always does, since it returns up to 30. That would silently
 * reduce the hybrid to its vector arm. Instead the vector arm fills the pool
 * by cosine rank, minus up to KEYWORD_RESERVE slots held for keyword-only
 * hits. The reserve costs nothing when the keyword arm is empty (the common
 * case for natural-language queries, where ILIKE '%whole sentence%' rarely
 * matches) — the vector arm simply takes every slot.
 *
 * Both arms' orderings are preserved as given: vector by cosine descending,
 * keyword by recency. The cross-encoder overwrites these scores anyway; the
 * ordering only decides who gets judged.
 */
export function selectRerankCandidates(
  vectorHits: RecallHit[],
  keywordHits: RecallHit[],
  pool: number,
  keywordReserve: number = KEYWORD_RESERVE
): RecallHit[] {
  const vectorIds = new Set(vectorHits.map(h => h.chunkId))
  const keywordOnly = keywordHits.filter(h => !vectorIds.has(h.chunkId))

  const kwTake = Math.min(keywordReserve, keywordOnly.length, pool)
  const vecTake = Math.max(0, pool - kwTake)

  const byId = new Map<string, RecallHit>()
  for (const h of vectorHits.slice(0, vecTake)) byId.set(h.chunkId, h)
  for (const h of keywordOnly.slice(0, kwTake)) byId.set(h.chunkId, h)
  return [...byId.values()]
}

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
      // Cap only this path: the cap exists to bound rerank cost, and the
      // non-rerank path pays none, so truncating it would drop results for
      // nothing.
      const candidates = selectRerankCandidates(
        vectorHits as RecallHit[],
        keywordHits as RecallHit[],
        rerankPoolSize()
      )
      try {
        const scores = await crossEncoderScore(
          query,
          candidates.map(h => h.content),
          // Chunks are 512 tokens — judge the whole chunk, like upload-rag.
          { maxLength: 512, timeoutMs: 10_000 }
        )
        hits = candidates
          .map((h, i) => ({ ...h, score: scores[i] ?? 0 }))
          .sort((a, b) => b.score - a.score)
        reranked = true
      } catch (error) {
        // Reranker down — keep the cosine ordering already computed. Log it:
        // with a rerank-scale minScore this fails closed below, silently
        // disabling recall for the turn. That must not be invisible.
        console.warn('[recall] rerank failed:', error)
      }
    }

    if (opts.minScore !== undefined) {
      // Fail closed: a rerank-scale minScore requested via useRerank: true
      // cannot be honoured if rerank didn't actually run — the scores left
      // in `hits` are still cosine, an unrelated scale (see doc comment
      // above), and comparing the rerank-scale threshold against them would
      // silently let almost everything through. Return nothing rather than
      // everything.
      if (opts.useRerank && !reranked) {
        console.warn(
          `[recall] fail-closed: rerank requested but did not run (configured=${isCrossEncoderConfigured()}, hits=${hits.length}) — no recall this turn`
        )
        return []
      }
      hits = hits.filter(h => h.score >= opts.minScore!)
    }

    return hits.slice(0, opts.topK)
  } catch (error) {
    // Always log. This used to be dev-only, which meant that in production —
    // the only place it matters — recall could throw on every turn and go
    // silently inert, indistinguishable from "no relevant history". Feature
    // A's setLastUsed bug hid behind exactly this shape of swallowed catch.
    console.warn('[recall] search failed:', error)
    return []
  }
}
