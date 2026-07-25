import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetBraveBreakerForTests,
  fetchBraveSearch,
  isBraveSearchConfigured
} from '../brave-search-client'

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

beforeEach(() => {
  vi.restoreAllMocks()
  __resetBraveBreakerForTests()
  process.env.BRAVE_SEARCH_API_KEY = 'test-key'
})
afterEach(() => {
  delete process.env.BRAVE_SEARCH_API_KEY
  delete process.env.BRAVE_MERGE_TIMEOUT_MS
})

describe('isBraveSearchConfigured', () => {
  it('is false without a key', () => {
    delete process.env.BRAVE_SEARCH_API_KEY
    expect(isBraveSearchConfigured()).toBe(false)
  })
  it('is true with a key', () => {
    expect(isBraveSearchConfigured()).toBe(true)
  })
})

describe('fetchBraveSearch', () => {
  it('returns null when unconfigured, without calling the API', async () => {
    delete process.env.BRAVE_SEARCH_API_KEY
    const f = vi.spyOn(global, 'fetch')
    await expect(fetchBraveSearch('anything', 5)).resolves.toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it('sends the key as a subscription header, never in the query string', async () => {
    const f = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(okResponse({ web: { results: [] } }))

    await fetchBraveSearch('turing gpus', 5)

    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).not.toContain('test-key')
    expect(
      (init.headers as Record<string, string>)['X-Subscription-Token']
    ).toBe('test-key')
  })

  it('maps web results to the shared shape', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      okResponse({
        web: {
          results: [
            { title: 'A', url: 'https://a.test', description: 'snippet a' },
            { title: 'B', url: 'https://b.test', description: 'snippet b' }
          ]
        }
      })
    )

    await expect(fetchBraveSearch('q', 5)).resolves.toEqual([
      { title: 'A', url: 'https://a.test', content: 'snippet a' },
      { title: 'B', url: 'https://b.test', content: 'snippet b' }
    ])
  })

  it('drops entries with no url rather than emitting a broken source', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      okResponse({
        web: {
          results: [
            { title: 'good', url: 'https://a.test', description: 'x' },
            { title: 'no url' },
            { title: 'empty url', url: '' }
          ]
        }
      })
    )

    const out = await fetchBraveSearch('q', 5)
    expect(out).toHaveLength(1)
    expect(out?.[0].url).toBe('https://a.test')
  })

  it('tolerates a response with no web block', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(okResponse({}))
    await expect(fetchBraveSearch('q', 5)).resolves.toEqual([])
  })

  it('throws on a non-OK response so the caller can degrade', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({})
    } as Response)

    await expect(fetchBraveSearch('q', 5)).rejects.toThrow('429')
  })

  it('opens a circuit breaker after a failure, then closes on success', async () => {
    const f = vi
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('network down'))

    await expect(fetchBraveSearch('q', 5)).rejects.toThrow('network down')

    // Second call must be suppressed by the breaker, not retried upstream.
    await expect(fetchBraveSearch('q', 5)).rejects.toThrow('cooldown')
    expect(f).toHaveBeenCalledTimes(1)

    __resetBraveBreakerForTests()
    f.mockResolvedValue(okResponse({ web: { results: [] } }))
    await expect(fetchBraveSearch('q', 5)).resolves.toEqual([])
  })

  it('caps count at the API maximum of 20', async () => {
    const f = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(okResponse({ web: { results: [] } }))

    await fetchBraveSearch('q', 500)

    const url = new URL((f.mock.calls[0] as [string, RequestInit])[0])
    expect(Number(url.searchParams.get('count'))).toBeLessThanOrEqual(20)
  })
})
