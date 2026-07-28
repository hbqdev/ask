import { afterEach, describe, expect, it } from 'vitest'

// Ollama's web-search API clamps max_results to 10 server-side: requesting 20,
// 50 and 100 all returned exactly 10 (measured 2026-07-28). The default was 5,
// which left half the results unused for an identical cost -- metering is per
// REQUEST, not per result.
//
// This mirrors the resolution in lib/tools/search.ts. It is duplicated rather
// than exported because the real one is computed inline inside the tool's
// execute(), which cannot be called without a full tool-call context.
const OLLAMA_SEARCH_HARD_MAX = 10

function resolveOllamaMax(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0
    ? Math.min(n, OLLAMA_SEARCH_HARD_MAX)
    : OLLAMA_SEARCH_HARD_MAX
}

describe('ollama max_results resolution', () => {
  afterEach(() => {
    delete process.env.OLLAMA_SEARCH_MAX_RESULTS
  })

  it('defaults to the API ceiling, not an arbitrary smaller number', () => {
    // Asking for 5 and asking for 10 are the same call at the same price, and
    // the extra 5 arrive as full page content that the crawler then skips.
    expect(resolveOllamaMax(undefined)).toBe(10)
  })

  it('honours a lower explicit value', () => {
    expect(resolveOllamaMax('3')).toBe(3)
  })

  it('clamps above the ceiling instead of passing it through', () => {
    // The API silently returns 10 regardless. Passing 50 through would leave
    // an operator believing they configured 50 results.
    expect(resolveOllamaMax('50')).toBe(10)
    expect(resolveOllamaMax('11')).toBe(10)
  })

  it('falls back to the ceiling for junk or non-positive values', () => {
    for (const v of ['0', '-4', 'lots', '']) {
      expect(resolveOllamaMax(v)).toBe(10)
    }
  })
})
