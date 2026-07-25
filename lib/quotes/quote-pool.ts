import type { Quote } from './types'

/**
 * A row is usable if it has both text and attribution. There is deliberately
 * NO length filter: the timing function adapts its cadence for long quotes, so
 * an 80-word entry is as valid as a two-word one.
 */
export function acceptQuote(row: unknown): row is Quote {
  if (!row || typeof row !== 'object') return false
  const { q, a } = row as { q?: unknown; a?: unknown }
  return (
    typeof q === 'string' &&
    q.trim().length > 0 &&
    typeof a === 'string' &&
    a.trim().length > 0
  )
}

/**
 * Validate, trim, dedupe and shuffle. Shuffled here (once, server-side) so the
 * client can simply walk the batch in order without repeating itself.
 */
export function normalizePool(
  rows: unknown[],
  random: () => number = Math.random
): Quote[] {
  const seen = new Set<string>()
  const out: Quote[] = []

  for (const row of rows) {
    if (!acceptQuote(row)) continue
    const q = row.q.trim()
    const key = q.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ q, a: row.a.trim() })
  }

  // Fisher-Yates, ascending: at step i pick j uniformly in [0, i] and swap.
  // Equivalent in distribution to the descending form, and it is the direction
  // the tests pin down (a source stuck at 0 walks each element to the front).
  for (let i = 1; i < out.length; i++) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
