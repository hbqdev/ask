import { recallSearch } from './recall-search'
import type { RecallHit } from './recall-types'

function injectTopK(): number {
  const n = Number(process.env.RECALL_INJECT_TOP_K)
  return Number.isFinite(n) && n > 0 ? n : 2
}

function injectMinScore(): number {
  const n = Number(process.env.RECALL_INJECT_MIN_SCORE)
  return Number.isFinite(n) ? n : 0.75
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
 * Deliberately useRerank: false — this runs on EVERY turn, so it stays a local
 * embed + an HNSW query with no network hop. minScore is the noise gate, and
 * it is a cosine threshold precisely because rerank is off here.
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
      useRerank: false,
      excludeChatId: currentChatId,
      minScore: injectMinScore()
    })
    return { block: buildRecallBlock(hits), hits }
  } catch {
    return { block: '', hits: [] }
  }
}
