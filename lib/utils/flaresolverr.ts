/**
 * Minimal client for FlareSolverr (self-hosted Cloudflare/bot-wall solver,
 * already running in the degoog stack). Used as the free middle tier of
 * the fetch rescue chain: tried after a plain fetch fails and before a
 * Firecrawl credit is spent.
 *
 * FLARESOLVERR_URL example: http://flaresolverr:8191 (the ask container
 * joins the degoog docker network; the service is loopback-bound on the
 * host, so the host-published port is not reachable from containers).
 */

const DEFAULT_TIMEOUT_MS = 30_000

export function isFlaresolverrConfigured(): boolean {
  return Boolean(process.env.FLARESOLVERR_URL)
}

export async function flaresolverrGet(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<string> {
  const baseUrl = process.env.FLARESOLVERR_URL
  if (!baseUrl) {
    throw new Error('FLARESOLVERR_URL is not configured')
  }

  const controller = new AbortController()
  // FlareSolverr's own maxTimeout governs the challenge-solving budget;
  // give the HTTP request a little extra headroom on top of it.
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs + 5_000)

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'request.get',
        url,
        maxTimeout: timeoutMs
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      throw new Error(`FlareSolverr HTTP ${response.status}`)
    }

    const json = (await response.json()) as {
      status?: string
      message?: string
      solution?: { status?: number; response?: string }
    }

    if (json.status !== 'ok' || !json.solution) {
      throw new Error(`FlareSolverr failed: ${json.message || json.status}`)
    }
    if ((json.solution.status ?? 500) >= 400) {
      throw new Error(`FlareSolverr target status ${json.solution.status}`)
    }
    if (!json.solution.response) {
      throw new Error('FlareSolverr returned an empty response body')
    }

    return json.solution.response
  } finally {
    clearTimeout(timeoutId)
  }
}
