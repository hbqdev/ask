import { recallSearch } from './recall-search'
import type { RecallHit } from './recall-types'

function injectTopK(): number {
  const n = Number(process.env.RECALL_INJECT_TOP_K)
  return Number.isFinite(n) && n > 0 ? n : 2
}

function injectMinScore(): number {
  const n = Number(process.env.RECALL_INJECT_MIN_SCORE)
  return Number.isFinite(n) ? n : 0.05
}

export function buildRecallBlock(hits: RecallHit[]): string {
  if (hits.length === 0) return ''
  const lines = hits
    .map(
      h =>
        `- From "${h.chatTitle}" (${h.createdAt.toISOString().slice(0, 10)}): ${h.content}`
    )
    .join('\n')
  return `\n\n## Relevant past conversations\nThese are excerpts from this user's earlier conversations with you, retrieved because they look relevant. Use them when they help; ignore them when they do not. Do not claim to remember something they did not say.\n${lines}`
}

/**
 * The recall block to append to the researcher's system prompt, plus the hits
 * themselves so the caller can stream an attribution part. Fail-safe: an empty
 * block on no userId / disabled / no hits / any error.
 *
 * useRerank: true. This used to be false, on the reasoning that running on
 * EVERY turn should stay a local embed with no network hop — but the live
 * E2E measured that cosine cannot discriminate here: a genuinely relevant
 * match scored 0.626 while an irrelevant chunk scored 0.570, a ~0.06-wide
 * band, making any fixed cosine threshold either unreachable or useless.
 * With auto-injection gated on cosine, it never fired — silently inert. The
 * cross-encoder separates the same query/passages by ~10,000x (0.169 vs
 * 0.0000164), so it is worth a network hop to make the gate real.
 *
 * Cost, measured on the live reranker, scales with the candidate
 * pool: 3 passages 489ms, 15 976ms, 30 3.4s, 60 7.6s. Both arms return up to
 * `max(topK*3, 30)` rows, so an uncapped union reranked ~60 and spent ~7.6s
 * against a 10s timeout — 2.4s from failing closed on every turn. recallSearch
 * therefore caps what it actually reranks (RECALL_RERANK_POOL, default 20).
 * (An earlier revision of this comment claimed "~150ms" — that was measured
 * with 3 passages and never described this path.) minScore
 * (RECALL_INJECT_MIN_SCORE) is now a threshold on the reranker's scale.
 * Fail-closed consequence: if the reranker is unreachable, recallSearch
 * cannot honour a rerank-scale gate and returns [] — no injection for that
 * turn. The turn proceeds normally without a recall block, which is the
 * correct fail-safe (no injection beats wrong injection).
 */
export async function getRecallInjection(
  userId: string | undefined,
  query: string,
  currentChatId: string | undefined
): Promise<{ block: string; hits: RecallHit[] }> {
  if (!userId || !query?.trim()) return { block: '', hits: [] }
  try {
    const hits = await recallSearch(userId, query, {
      topK: injectTopK(),
      useRerank: true,
      excludeChatId: currentChatId,
      minScore: injectMinScore()
    })
    return { block: buildRecallBlock(hits), hits }
  } catch (error) {
    console.warn('[recall] injection failed:', error)
    return { block: '', hits: [] }
  }
}
