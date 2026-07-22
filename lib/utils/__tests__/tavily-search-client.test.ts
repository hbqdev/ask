import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `fetchTavilySearch` keeps a module-level circuit-breaker timestamp
// (`downUntil`), like ollama-search-client. Reset modules per test so a tripped
// breaker doesn't leak into later tests.
async function importFreshModule() {
  vi.resetModules()
  return import('../tavily-search-client')
}

describe('tavily-search-client', () => {
  beforeEach(() => {
    delete process.env.TAVILY_API_KEY
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.TAVILY_API_KEY
  })

  it('isTavilySearchConfigured reflects the key', async () => {
    const { isTavilySearchConfigured } = await importFreshModule()
    expect(isTavilySearchConfigured()).toBe(false)
    process.env.TAVILY_API_KEY = 'tvly-k'
    expect(isTavilySearchConfigured()).toBe(true)
  })

  it('returns null when the key is unset (feature inert)', async () => {
    const { fetchTavilySearch } = await importFreshModule()
    expect(await fetchTavilySearch('rust lang', 3)).toBeNull()
  })

  it('parses {results:[{title,url,content}]} and sends api_key + basic depth', async () => {
    process.env.TAVILY_API_KEY = 'tvly-k'
    const { fetchTavilySearch } = await importFreshModule()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { title: 'A', url: 'https://a.com', content: 'aaa' },
          { title: 'B', url: 'https://b.com', content: 'bbb' }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await fetchTavilySearch('rust lang', 2)
    expect(res).toEqual([
      { title: 'A', url: 'https://a.com', content: 'aaa' },
      { title: 'B', url: 'https://b.com', content: 'bbb' }
    ])
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.api_key).toBe('tvly-k')
    expect(body.search_depth).toBe('basic')
    expect(body.query).toBe('rust lang')
  })

  it('pads a short query to Tavily’s 5-char minimum', async () => {
    process.env.TAVILY_API_KEY = 'tvly-k'
    const { fetchTavilySearch } = await importFreshModule()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    await fetchTavilySearch('go', 3)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.query.length).toBeGreaterThanOrEqual(5)
    expect(body.query.trimEnd()).toBe('go')
  })

  it('throws on a non-OK response (so callers can degrade)', async () => {
    process.env.TAVILY_API_KEY = 'tvly-k'
    const { fetchTavilySearch } = await importFreshModule()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 432, json: async () => ({}) })
    )
    await expect(fetchTavilySearch('rust lang', 3)).rejects.toThrow(/432/)
  })

  it('drops results with no url', async () => {
    process.env.TAVILY_API_KEY = 'tvly-k'
    const { fetchTavilySearch } = await importFreshModule()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ title: 'x', content: 'c' }, { url: 'https://y.com' }]
        })
      })
    )
    expect(await fetchTavilySearch('rust lang', 3)).toEqual([
      { title: '', url: 'https://y.com', content: '' }
    ])
  })
})
