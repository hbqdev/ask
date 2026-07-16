// Client for Ollama's hosted web search (a complement to SearXNG/degoog, not a
// replacement). Runs on Ollama's servers, so it egresses from Ollama's IPs, not
// our residential IP — immune to the DDG/Startpage-style IP blocking that hits
// self-hosted engines. Returns full page content per result. Inert unless
// OLLAMA_SEARCH_API_KEY (the Ollama CLOUD key, distinct from OLLAMA_BASE_URL) is
// set. Mirrors degoog-client's null-when-unconfigured / throw-on-failure /
// circuit-breaker contract.

const OLLAMA_SEARCH_ENDPOINT = 'https://ollama.com/api/web_search'
const DEFAULT_TIMEOUT_MS = 10_000
const BREAKER_COOLDOWN_MS = 30_000

let downUntil = 0

export interface OllamaSearchResult {
  title: string
  url: string
  content: string
}

export function isOllamaSearchConfigured(): boolean {
  return Boolean(process.env.OLLAMA_SEARCH_API_KEY)
}

/**
 * Query Ollama web search. Returns `null` when unconfigured (callers treat
 * Ollama as optional). Throws on timeout/non-OK/network so callers can degrade
 * to searxng+degoog. A short circuit-breaker cooldown suppresses repeated
 * attempts during an outage.
 */
export async function fetchOllamaSearch(
  query: string,
  maxResults: number,
  options: { timeoutMs?: number } = {}
): Promise<OllamaSearchResult[] | null> {
  const apiKey = process.env.OLLAMA_SEARCH_API_KEY
  if (!apiKey) return null

  if (Date.now() < downUntil) {
    throw new Error('ollama web search is in circuit-breaker cooldown')
  }

  const envTimeout = Number(process.env.OLLAMA_SEARCH_TIMEOUT_MS)
  const timeoutMs =
    options.timeoutMs ??
    (Number.isFinite(envTimeout) && envTimeout > 0
      ? envTimeout
      : DEFAULT_TIMEOUT_MS)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(OLLAMA_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ query, max_results: maxResults }),
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`ollama web search responded with ${response.status}`)
    }
    const json = (await response.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>
    }
    const results = (json.results ?? [])
      .filter(
        (r): r is { url: string; title?: string; content?: string } =>
          Boolean(r) && typeof r.url === 'string' && r.url.length > 0
      )
      .map(r => ({
        title: r.title ?? '',
        url: r.url,
        content: r.content ?? ''
      }))
    downUntil = 0
    return results
  } catch (error) {
    downUntil = Date.now() + BREAKER_COOLDOWN_MS
    throw error
  } finally {
    clearTimeout(timer)
  }
}
