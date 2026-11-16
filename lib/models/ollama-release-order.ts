import { Model } from '@/lib/types/models'

// Orders the Ollama model picker newest-first by the date ollama.com lists
// for each model (`modified_at` from the public library tags endpoint).
// Any failure falls back to plain name order; this module never throws.

const DEFAULT_TAGS_URL = 'https://ollama.com/api/tags'
const FETCH_TIMEOUT_MS = 3_000
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000
const FAILURE_TTL_MS = 5 * 60 * 1000

let cache: { expiresAt: number; value: Map<string, number> } | undefined
let inflight: Promise<Map<string, number>> | undefined

/** Test-only: drop the cached release dates. */
export function __resetOllamaReleaseDatesCache(): void {
  cache = undefined
  inflight = undefined
}

/** `X:cloud` → `X`; otherwise the part before the first `:`. */
export function ollamaBaseName(id: string): string {
  if (id.endsWith(':cloud')) return id.slice(0, -':cloud'.length)
  const colon = id.indexOf(':')
  return colon === -1 ? id : id.slice(0, colon)
}

/**
 * Newest date among library names equal to `base` or tagged revisions of it
 * (`<base>:<tag>`). `kimi-k3` does not match `kimi-k3.1-pro`.
 */
export function releaseDateFor(
  base: string,
  dates: Map<string, number>
): number | undefined {
  let newest: number | undefined
  for (const [name, date] of dates) {
    if (name !== base && !name.startsWith(`${base}:`)) continue
    if (newest === undefined || date > newest) newest = date
  }
  return newest
}

/** Date descending; ties by name; undated after all dated, by name. */
export function sortByReleaseDate(
  models: Model[],
  dates: Map<string, number>
): Model[] {
  const dated = models.map(model => ({
    model,
    date: releaseDateFor(ollamaBaseName(model.id), dates)
  }))
  return dated
    .sort((a, b) => {
      if (a.date !== undefined && b.date !== undefined && a.date !== b.date) {
        return b.date - a.date
      }
      if (a.date === undefined && b.date !== undefined) return 1
      if (a.date !== undefined && b.date === undefined) return -1
      return a.model.name.localeCompare(b.model.name)
    })
    .map(entry => entry.model)
}

async function loadReleaseDates(): Promise<Map<string, number>> {
  const url = process.env.OLLAMA_LIBRARY_TAGS_URL || DEFAULT_TAGS_URL
  const response = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  const json = (await response.json()) as { models?: unknown }
  if (!Array.isArray(json?.models)) {
    throw new Error('missing models array')
  }

  const dates = new Map<string, number>()
  for (const item of json.models as Record<string, unknown>[]) {
    const name = String(item?.name ?? item?.model ?? '')
    const date = Date.parse(String(item?.modified_at ?? ''))
    if (!name || Number.isNaN(date)) continue
    const prev = dates.get(name)
    if (prev === undefined || date > prev) dates.set(name, date)
  }
  return dates
}

/**
 * Ollama library name → newest `modified_at` (epoch ms). Cached 6 h on
 * success; a failure is cached 5 min and yields an empty map.
 */
export async function fetchOllamaReleaseDates(): Promise<Map<string, number>> {
  if (cache && cache.expiresAt > Date.now()) return cache.value
  if (inflight) return inflight

  inflight = loadReleaseDates()
    .then(value => {
      cache = { value, expiresAt: Date.now() + SUCCESS_TTL_MS }
      return value
    })
    .catch(error => {
      console.warn('[ModelFetch] Failed to fetch Ollama release dates:', error)
      const value = new Map<string, number>()
      cache = { value, expiresAt: Date.now() + FAILURE_TTL_MS }
      return value
    })
    .finally(() => {
      inflight = undefined
    })

  return inflight
}
