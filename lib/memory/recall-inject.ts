import {
  rankRecallCandidates,
  recallSearch,
  retrieveRecallCandidates
} from './recall-search'
import type { RecallCandidates, RecallHit, RecallOptions } from './recall-types'

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
 * Cost is linear in passages x tokens on the live reranker (Qwen3-Reranker-8B,
 * ~160ms per 512-token passage, measured 2026-09-23). recallSearch therefore
 * caps what it reranks: RECALL_RERANK_POOL (default 10) passages at
 * RECALL_RERANK_MAX_LENGTH (default 384) tokens, ~1.3s — inside the turn's
 * 1.5s RECALL_BUDGET_MS. (20 x 512 cost ~3.4s and missed the budget on
 * nearly every turn.) minScore
 * (RECALL_INJECT_MIN_SCORE) is now a threshold on the reranker's scale.
 * Fail-closed consequence: if the reranker is unreachable, recallSearch
 * cannot honour a rerank-scale gate and returns [] — no injection for that
 * turn. The turn proceeds normally without a recall block, which is the
 * correct fail-safe (no injection beats wrong injection).
 */
function injectOptions(currentChatId: string | undefined): RecallOptions {
  return {
    topK: injectTopK(),
    useRerank: true,
    excludeChatId: currentChatId,
    minScore: injectMinScore()
  }
}

/**
 * Speculative, GPU-free first half of the injection: embed + both DB arms for
 * `query`, started while the classifier is still running. The rerank is NOT
 * started here — pass the result to getRecallInjection only once the turn
 * knows it will use this query. Measured 2026-09-23: the old speculation ran
 * the full rerank too, and on the (common) 'refetch' turns that discarded
 * rerank was still occupying the reranker GPU when the refetch rerank
 * arrived, so the refetch queued behind it (solo 3.3s -> 5.0s, matching the
 * ~5.5s prod recall_ms). Never rejects: null on no userId / disabled / error.
 */
export function prefetchRecallCandidates(
  userId: string | undefined,
  query: string,
  currentChatId: string | undefined
): Promise<RecallCandidates | null> {
  if (!userId || !query?.trim()) return Promise.resolve(null)
  return retrieveRecallCandidates(
    userId,
    query,
    injectOptions(currentChatId)
  ).catch(error => {
    console.warn('[recall] prefetch failed:', error)
    return null
  })
}

/**
 * `prefetched` (optional): candidates from prefetchRecallCandidates for this
 * same query and chat — only the rerank + gate run here. Omitted: the full
 * retrieve + rerank runs.
 */
export async function getRecallInjection(
  userId: string | undefined,
  query: string,
  currentChatId: string | undefined,
  prefetched?: Promise<RecallCandidates | null>
): Promise<{ block: string; hits: RecallHit[] }> {
  if (!userId || !query?.trim()) return { block: '', hits: [] }
  try {
    const opts = injectOptions(currentChatId)
    let hits: RecallHit[]
    if (prefetched) {
      const candidates = await prefetched
      hits = candidates ? await rankRecallCandidates(candidates, opts) : []
    } else {
      hits = await recallSearch(userId, query, opts)
    }
    return { block: buildRecallBlock(hits), hits }
  } catch (error) {
    console.warn('[recall] injection failed:', error)
    return { block: '', hits: [] }
  }
}
