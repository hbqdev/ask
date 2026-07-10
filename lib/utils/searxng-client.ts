// Shared SearXNG fetch helper with automatic failover.
//
// SEARXNG_API_URL is the primary instance (typically an existing external
// deployment also used outside this app). SEARXNG_FALLBACK_API_URL is an
// optional secondary instance (e.g. the locally-bundled container in
// docker-compose.yaml) used when the primary is unreachable or errors.
//
// A short breaker window skips retrying a known-down primary on every
// request during a sustained outage — without it, every search would pay
// the primary's timeout cost before falling back, doubling latency for the
// whole outage instead of just the first request.

const REQUEST_TIMEOUT_MS = 8_000
const BREAKER_COOLDOWN_MS = 30_000

let primaryDownUntil = 0

async function fetchWithTimeout(
  url: string,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJsonFrom(
  baseUrl: string,
  buildUrl: (baseUrl: string) => string,
  timeoutMs: number
): Promise<unknown> {
  const response = await fetchWithTimeout(buildUrl(baseUrl), timeoutMs)
  if (!response.ok) {
    throw new Error(`SearXNG responded with ${response.status}`)
  }
  return response.json()
}

export interface SearxngFetchResult {
  data: unknown
  baseUrlUsed: string
}

/**
 * Fetches JSON from a SearXNG instance, automatically failing over to
 * SEARXNG_FALLBACK_API_URL if the primary (SEARXNG_API_URL) is unreachable,
 * times out, or returns a non-OK status.
 *
 * @param buildUrl Given a base URL, returns the full request URL (so each
 *   caller can append its own query params without duplicating the
 *   failover/timeout mechanics).
 */
export async function fetchSearxngJson(
  buildUrl: (baseUrl: string) => string,
  options: { timeoutMs?: number } = {}
): Promise<SearxngFetchResult> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const primary = process.env.SEARXNG_API_URL
  const fallback = process.env.SEARXNG_FALLBACK_API_URL

  if (!primary && !fallback) {
    throw new Error('SEARXNG_API_URL is not set in the environment variables')
  }

  const breakerOpen = Boolean(fallback) && Date.now() < primaryDownUntil

  if (primary && !breakerOpen) {
    try {
      const data = await fetchJsonFrom(primary, buildUrl, timeoutMs)
      primaryDownUntil = 0
      return { data, baseUrlUsed: primary }
    } catch (error) {
      if (!fallback) throw error
      console.warn(
        `[SearXNG] Primary instance failed, falling back to secondary: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      primaryDownUntil = Date.now() + BREAKER_COOLDOWN_MS
    }
  }

  if (fallback) {
    try {
      const data = await fetchJsonFrom(fallback, buildUrl, timeoutMs)
      return { data, baseUrlUsed: fallback }
    } catch (fallbackError) {
      // Breaker was open (we skipped primary above) and fallback also
      // failed — try primary anyway as a last resort rather than give up.
      if (primary && breakerOpen) {
        const data = await fetchJsonFrom(primary, buildUrl, timeoutMs)
        primaryDownUntil = 0
        return { data, baseUrlUsed: primary }
      }
      throw fallbackError
    }
  }

  throw new Error(
    'SearXNG primary instance failed and no fallback is configured'
  )
}
