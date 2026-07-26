import { describe, expect, it, vi } from 'vitest'

import {
  basicSearchCacheKey,
  withBasicSearchCache
} from '../basic-search-cache'

// Only the FIRST search of a turn goes through /api/advanced-search, which
// caches. The 3 expansion variants and every follow-up search tier down to
// basic depth and call the provider directly, bypassing the cache entirely —
// on a 10-tool-call turn that is ~11 of 12 requests, 92% of engine load.
//
// SearXNG then fans each of those to bing + google cse, and DuckDuckGo has
// been returning CAPTCHAs. Caching repeats is quality-neutral: identical
// queries return identical results, so nothing the model sees changes.
describe('basicSearchCacheKey', () => {
  it('is stable for identical inputs', () => {
    const a = basicSearchCacheKey('vllm vs llama.cpp', 10, 'month')
    const b = basicSearchCacheKey('vllm vs llama.cpp', 10, 'month')
    expect(a).toBe(b)
  })

  it('separates different queries', () => {
    expect(basicSearchCacheKey('a', 10)).not.toBe(basicSearchCacheKey('b', 10))
  })

  it('separates different result counts and time ranges', () => {
    expect(basicSearchCacheKey('a', 10)).not.toBe(basicSearchCacheKey('a', 20))
    expect(basicSearchCacheKey('a', 10, 'day')).not.toBe(
      basicSearchCacheKey('a', 10, 'week')
    )
  })

  it('shares the search: prefix so existing cache tooling still finds it', () => {
    // Flushing with `--scan --pattern 'search:*'` must clear these too.
    expect(basicSearchCacheKey('a', 10).startsWith('search:')).toBe(true)
  })

  it('is namespaced apart from the advanced cache to avoid collisions', () => {
    // An advanced result carries crawled+reranked content; a basic one does
    // not. Serving one for the other would silently change what the model reads.
    expect(basicSearchCacheKey('a', 10)).toContain('basic')
  })
})

describe('withBasicSearchCache', () => {
  const results = { results: [{ title: 't', url: 'u', content: 'c' }] }

  it('runs the search and stores the result on a miss', async () => {
    const store = new Map<string, string>()
    const search = vi.fn(async () => results)
    const out = await withBasicSearchCache('k1', search, {
      get: async k => store.get(k) ?? null,
      set: async (k, v) => void store.set(k, v)
    })
    expect(out).toEqual(results)
    expect(search).toHaveBeenCalledTimes(1)
    expect(store.has('k1')).toBe(true)
  })

  it('serves a hit WITHOUT calling the search — the whole point', async () => {
    const store = new Map([['k1', JSON.stringify(results)]])
    const search = vi.fn(async () => results)
    const out = await withBasicSearchCache('k1', search, {
      get: async k => store.get(k) ?? null,
      set: async () => {}
    })
    expect(out).toEqual(results)
    expect(search).not.toHaveBeenCalled()
  })

  it('falls through to the search when the cache read throws', async () => {
    // A Redis outage must degrade to today's behaviour, not break search.
    const search = vi.fn(async () => results)
    const out = await withBasicSearchCache('k1', search, {
      get: async () => {
        throw new Error('redis down')
      },
      set: async () => {}
    })
    expect(out).toEqual(results)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('still returns results when the cache WRITE throws', async () => {
    const search = vi.fn(async () => results)
    const out = await withBasicSearchCache('k1', search, {
      get: async () => null,
      set: async () => {
        throw new Error('redis down')
      }
    })
    expect(out).toEqual(results)
  })

  it('ignores unparseable cached data rather than returning garbage', async () => {
    const search = vi.fn(async () => results)
    const out = await withBasicSearchCache('k1', search, {
      get: async () => 'not json',
      set: async () => {}
    })
    expect(out).toEqual(results)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('does not cache an empty result set', async () => {
    // Caching a transient engine failure would persist it for the whole TTL.
    const store = new Map<string, string>()
    const search = vi.fn(async () => ({ results: [] }))
    await withBasicSearchCache('k1', search, {
      get: async () => null,
      set: async (k, v) => void store.set(k, v)
    })
    expect(store.size).toBe(0)
  })
})
