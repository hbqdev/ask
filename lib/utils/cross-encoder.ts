/**
 * Client for the self-hosted cross-encoder reranker service
 * (selfhosted/reranker, at RERANKER_URL). The service
 * scores each (query, passage) pair jointly — a stronger relevance signal
 * than comparing separately-embedded vectors. Reached over the LAN with a
 * bearer token (the service is LAN-published, unlike the same-host
 * loopback services). Feature is inert unless both env vars are set.
 *
 * Memory recall may use its own instance (RECALL_RERANKER_URL, same token):
 * recall has a 1.5s critical-path budget and must not queue behind
 * 100+-passage search reranks on the shared one. See recallRerankerUrl.
 */

const DEFAULT_TIMEOUT_MS = 20_000

/**
 * `baseUrl` defaults to RERANKER_URL (search reranking, upload/URL RAG);
 * recall passes recallRerankerUrl(). Every instance shares RERANKER_API_TOKEN.
 */
export function isCrossEncoderConfigured(
  baseUrl: string | undefined = process.env.RERANKER_URL
): boolean {
  return Boolean(baseUrl && process.env.RERANKER_API_TOKEN)
}

/**
 * The reranker endpoint for memory recall: RECALL_RERANKER_URL when set (a
 * dedicated instance, so recall's 1.5s RECALL_BUDGET_MS is not spent queued
 * behind search reranks), else RERANKER_URL exactly as before.
 */
export function recallRerankerUrl(): string | undefined {
  return process.env.RECALL_RERANKER_URL?.trim() || process.env.RERANKER_URL
}

/**
 * Score each passage against the query. Returns scores in [0,1],
 * index-aligned to `passages`. Throws on any transport/auth/HTTP failure so
 * callers can fall back to the bi-encoder path.
 */
export async function crossEncoderScore(
  query: string,
  passages: string[],
  opts?: { timeoutMs?: number; maxLength?: number; baseUrl?: string }
): Promise<number[]> {
  if (passages.length === 0) return []
  // opts.baseUrl: another reranker instance (recall); default RERANKER_URL.
  const baseUrl = opts?.baseUrl ?? process.env.RERANKER_URL
  const token = process.env.RERANKER_API_TOKEN
  if (!baseUrl || !token) {
    throw new Error('RERANKER_URL / RERANKER_API_TOKEN are not configured')
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(
    () => controller.abort(),
    opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  )
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        query,
        passages,
        // Omit unless set so the service applies its own default (128).
        ...(opts?.maxLength != null && { max_length: opts.maxLength })
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`Reranker HTTP ${response.status}`)
    }
    const json = (await response.json()) as { scores?: number[] }
    if (!Array.isArray(json.scores) || json.scores.length !== passages.length) {
      throw new Error('Reranker returned a malformed scores array')
    }
    return json.scores
  } finally {
    clearTimeout(timeoutId)
  }
}
