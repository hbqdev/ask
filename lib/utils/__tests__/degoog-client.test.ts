import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function importFreshModule() {
  vi.resetModules()
  return import('../degoog-client')
}

function mockResponse(ok: boolean, jsonValue: unknown, status = 200) {
  return {
    ok,
    status,
    json: async () => jsonValue
  }
}

describe('fetchDegoogJson', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('returns null (not an error) when DEGOOG_API_URL is not configured', async () => {
    vi.stubEnv('DEGOOG_API_URL', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { fetchDegoogJson } = await importFreshModule()

    const result = await fetchDegoogJson(base => `${base}/api/search`)

    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // One switch has to reach BOTH fan-outs. The advanced route
  // (app/api/advanced-search/route.ts) gated degoog behind its own
  // DEGOOG_ENABLED const while the basic provider
  // (lib/tools/search/providers/searxng.ts) gated only on DEGOOG_API_URL, so
  // turning degoog "off" silently left it firing on every search after the
  // first. Gating here means neither caller can miss it.
  it('returns null when DEGOOG_ENABLED is explicitly off', async () => {
    vi.stubEnv('DEGOOG_API_URL', 'https://degoog.example')
    vi.stubEnv('DEGOOG_ENABLED', 'false')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { fetchDegoogJson } = await importFreshModule()

    const result = await fetchDegoogJson(base => `${base}/api/search`)

    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Default ON: degoog contributes 7 engines SearXNG is never asked for
  // (reddit, hacker news, lemmy, internet archive, wikimedia commons, nasa
  // images, openverse), so an unset flag must not silently drop them.
  it('fetches when DEGOOG_ENABLED is unset', async () => {
    vi.stubEnv('DEGOOG_API_URL', 'https://degoog.example')
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse(true, { results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchDegoogJson } = await importFreshModule()

    const result = await fetchDegoogJson(base => `${base}/api/search`)

    expect(result).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fetches with a Bearer auth header when an API key is configured', async () => {
    vi.stubEnv('DEGOOG_API_URL', 'https://degoog.example')
    vi.stubEnv('DEGOOG_API_KEY', 'secret-key')
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse(true, { results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchDegoogJson } = await importFreshModule()

    const result = await fetchDegoogJson(base => `${base}/api/search?q=x`)

    expect(result).toEqual({ data: { results: [] } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://degoog.example/api/search?q=x'
    )
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer secret-key'
    )
  })

  it('omits the Authorization header when no API key is configured', async () => {
    vi.stubEnv('DEGOOG_API_URL', 'https://degoog.example')
    vi.stubEnv('DEGOOG_API_KEY', '')
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse(true, { results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchDegoogJson } = await importFreshModule()

    await fetchDegoogJson(base => `${base}/api/search`)

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })

  it('throws on a non-OK response', async () => {
    vi.stubEnv('DEGOOG_API_URL', 'https://degoog.example')
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(false, null, 503))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchDegoogJson } = await importFreshModule()

    await expect(fetchDegoogJson(base => `${base}/api/search`)).rejects.toThrow(
      /503/
    )
  })

  it('opens the circuit breaker after a failure and skips subsequent calls during cooldown', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.stubEnv('DEGOOG_API_URL', 'https://degoog.example')
    const fetchMock = vi.fn().mockRejectedValue(new Error('down'))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchDegoogJson } = await importFreshModule()

    await expect(fetchDegoogJson(base => `${base}/api/search`)).rejects.toThrow(
      'down'
    )

    vi.setSystemTime(5_000) // still within the 30s cooldown
    await expect(fetchDegoogJson(base => `${base}/api/search`)).rejects.toThrow(
      /circuit-breaker cooldown/
    )

    // Only the first call actually hit the network; the second was
    // short-circuited by the breaker.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries after the breaker cooldown expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.stubEnv('DEGOOG_API_URL', 'https://degoog.example')
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(mockResponse(true, { results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchDegoogJson } = await importFreshModule()

    await expect(fetchDegoogJson(base => `${base}/api/search`)).rejects.toThrow(
      'down'
    )

    vi.setSystemTime(31_000) // past the 30s cooldown
    const result = await fetchDegoogJson(base => `${base}/api/search`)

    expect(result).toEqual({ data: { results: [] } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
