/**
 * Client for the self-hosted cross-encoder reranker service
 * (selfhosted/reranker, running on the P4000 at RERANKER_URL). The service
 * scores each (query, passage) pair jointly — a stronger relevance signal
 * than comparing separately-embedded vectors. Reached over the LAN with a
 * bearer token (the service is LAN-published, unlike the same-host
 * loopback services). Feature is inert unless both env vars are set.
 */

const DEFAULT_TIMEOUT_MS = 20_000

export function isCrossEncoderConfigured(): boolean {
  return Boolean(process.env.RERANKER_URL && process.env.RERANKER_API_TOKEN)
}

/**
 * Score each passage against the query. Returns scores in [0,1],
 * index-aligned to `passages`. Throws on any transport/auth/HTTP failure so
 * callers can fall back to the bi-encoder path.
 */
export async function crossEncoderScore(
  query: string,
  passages: string[],
  opts?: { timeoutMs?: number }
): Promise<number[]> {
  if (passages.length === 0) return []
  const baseUrl = process.env.RERANKER_URL
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
      body: JSON.stringify({ query, passages }),
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
