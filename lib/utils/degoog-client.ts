// Fetch helper for the degoog metasearch aggregator (a complement to
// SearXNG, not a replacement — see lib/tools/search/providers/searxng.ts).
//
// Unlike SearXNG there is only one instance to call, so there's no
// primary/fallback failover here. There IS still a short circuit-breaker
// cooldown: without one, a degoog outage would tax *every* search with a
// full timeout even though SearXNG alone would still answer quickly.

const REQUEST_TIMEOUT_MS = 8_000
const BREAKER_COOLDOWN_MS = 30_000

let downUntil = 0

async function fetchWithTimeout(
  url: string,
  apiKey: string | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }
}

export interface DegoogFetchResult {
  data: unknown
}

/**
 * Fetches JSON from the configured degoog instance. Returns `null` (rather
 * than throwing) when `DEGOOG_API_URL` isn't configured, so callers can
 * treat degoog as an optional enhancement — deployments without it are
 * unaffected. Throws on network/timeout/non-OK errors so callers can decide
 * how to degrade (this mirrors fetchSearxngJson's contract for real
 * failures, just without a second instance to fail over to).
 *
 * @param buildUrl Given the base URL, returns the full request URL.
 */
export async function fetchDegoogJson(
  buildUrl: (baseUrl: string) => string,
  options: { timeoutMs?: number } = {}
): Promise<DegoogFetchResult | null> {
  const baseUrl = process.env.DEGOOG_API_URL
  if (!baseUrl) return null

  if (Date.now() < downUntil) {
    throw new Error('degoog is in circuit-breaker cooldown')
  }

  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  try {
    const response = await fetchWithTimeout(
      buildUrl(baseUrl),
      process.env.DEGOOG_API_KEY,
      timeoutMs
    )
    if (!response.ok) {
      throw new Error(`degoog responded with ${response.status}`)
    }
    downUntil = 0
    return { data: await response.json() }
  } catch (error) {
    downUntil = Date.now() + BREAKER_COOLDOWN_MS
    throw error
  }
}
