import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function importFreshModule() {
  vi.resetModules()
  return import('../searxng-client')
}

function mockResponse(ok: boolean, jsonValue: unknown, status = 200) {
  return {
    ok,
    status,
    json: async () => jsonValue
  }
}

describe('fetchSearxngJson', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('throws immediately when neither URL is configured', async () => {
    vi.stubEnv('SEARXNG_API_URL', '')
    vi.stubEnv('SEARXNG_FALLBACK_API_URL', '')
    const { fetchSearxngJson } = await importFreshModule()

    await expect(fetchSearxngJson(base => `${base}/search`)).rejects.toThrow(
      /SEARXNG_API_URL is not set/
    )
  })

  it('uses the primary instance when it succeeds', async () => {
    vi.stubEnv('SEARXNG_API_URL', 'https://primary.example')
    vi.stubEnv('SEARXNG_FALLBACK_API_URL', 'http://fallback.local')
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse(true, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSearxngJson } = await importFreshModule()

    const result = await fetchSearxngJson(base => `${base}/search`)

    expect(result.baseUrlUsed).toBe('https://primary.example')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://primary.example/search')
  })

  it('falls over to the fallback when the primary request fails', async () => {
    vi.stubEnv('SEARXNG_API_URL', 'https://primary.example')
    vi.stubEnv('SEARXNG_FALLBACK_API_URL', 'http://fallback.local')
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(mockResponse(true, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSearxngJson } = await importFreshModule()

    const result = await fetchSearxngJson(base => `${base}/search`)

    expect(result.baseUrlUsed).toBe('http://fallback.local')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls over when the primary returns a non-OK status', async () => {
    vi.stubEnv('SEARXNG_API_URL', 'https://primary.example')
    vi.stubEnv('SEARXNG_FALLBACK_API_URL', 'http://fallback.local')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(false, null, 503))
      .mockResolvedValueOnce(mockResponse(true, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSearxngJson } = await importFreshModule()

    const result = await fetchSearxngJson(base => `${base}/search`)
    expect(result.baseUrlUsed).toBe('http://fallback.local')
  })

  it('throws when both primary and fallback fail', async () => {
    vi.stubEnv('SEARXNG_API_URL', 'https://primary.example')
    vi.stubEnv('SEARXNG_FALLBACK_API_URL', 'http://fallback.local')
    const fetchMock = vi.fn().mockRejectedValue(new Error('down'))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSearxngJson } = await importFreshModule()

    await expect(fetchSearxngJson(base => `${base}/search`)).rejects.toThrow(
      'down'
    )
  })

  it('does not attempt failover when no fallback is configured', async () => {
    vi.stubEnv('SEARXNG_API_URL', 'https://primary.example')
    vi.stubEnv('SEARXNG_FALLBACK_API_URL', '')
    const fetchMock = vi.fn().mockRejectedValue(new Error('down'))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSearxngJson } = await importFreshModule()

    await expect(fetchSearxngJson(base => `${base}/search`)).rejects.toThrow(
      'down'
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('skips the primary on subsequent requests during the breaker cooldown window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.stubEnv('SEARXNG_API_URL', 'https://primary.example')
    vi.stubEnv('SEARXNG_FALLBACK_API_URL', 'http://fallback.local')
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('down')) // request 1: primary fails
      .mockResolvedValueOnce(mockResponse(true, { first: true })) // request 1: fallback succeeds
      .mockResolvedValueOnce(mockResponse(true, { second: true })) // request 2: fallback (primary skipped)
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSearxngJson } = await importFreshModule()

    await fetchSearxngJson(base => `${base}/search`)
    vi.setSystemTime(5000) // still within the 30s cooldown
    const result = await fetchSearxngJson(base => `${base}/search`)

    expect(result.baseUrlUsed).toBe('http://fallback.local')
    // 2 calls for request 1 (primary fail + fallback), 1 call for request 2
    // (fallback only — primary was skipped due to the open breaker).
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries the primary again after the breaker cooldown expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.stubEnv('SEARXNG_API_URL', 'https://primary.example')
    vi.stubEnv('SEARXNG_FALLBACK_API_URL', 'http://fallback.local')
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(mockResponse(true, { first: true }))
      .mockResolvedValueOnce(mockResponse(true, { recovered: true }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSearxngJson } = await importFreshModule()

    await fetchSearxngJson(base => `${base}/search`) // primary fails, fallback used
    vi.setSystemTime(31_000) // past the 30s cooldown
    const result = await fetchSearxngJson(base => `${base}/search`)

    expect(result.baseUrlUsed).toBe('https://primary.example')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('uses the fallback alone when only it is configured', async () => {
    vi.stubEnv('SEARXNG_API_URL', '')
    vi.stubEnv('SEARXNG_FALLBACK_API_URL', 'http://fallback.local')
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse(true, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchSearxngJson } = await importFreshModule()

    const result = await fetchSearxngJson(base => `${base}/search`)

    expect(result.baseUrlUsed).toBe('http://fallback.local')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
