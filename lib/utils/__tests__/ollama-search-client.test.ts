import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `fetchOllamaSearch` keeps a module-level circuit-breaker timestamp
// (`downUntil`), same as degoog-client. Tests that intentionally trip the
// breaker would otherwise leak that state into later tests in this file, so
// — mirroring lib/utils/__tests__/degoog-client.test.ts — each test resets
// modules and re-imports fresh.
async function importFreshModule() {
  vi.resetModules()
  return import('../ollama-search-client')
}

describe('ollama-search-client', () => {
  beforeEach(() => {
    delete process.env.OLLAMA_SEARCH_API_KEY
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.OLLAMA_SEARCH_API_KEY
  })

  it('isOllamaSearchConfigured reflects the key', async () => {
    const { isOllamaSearchConfigured } = await importFreshModule()
    expect(isOllamaSearchConfigured()).toBe(false)
    process.env.OLLAMA_SEARCH_API_KEY = 'k'
    expect(isOllamaSearchConfigured()).toBe(true)
  })

  it('returns null when the key is unset (feature inert)', async () => {
    const { fetchOllamaSearch } = await importFreshModule()
    const res = await fetchOllamaSearch('rust', 3)
    expect(res).toBeNull()
  })

  it('parses {results:[{title,url,content}]} on success', async () => {
    process.env.OLLAMA_SEARCH_API_KEY = 'k'
    const { fetchOllamaSearch } = await importFreshModule()
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

    const res = await fetchOllamaSearch('rust', 2)
    expect(res).toEqual([
      { title: 'A', url: 'https://a.com', content: 'aaa' },
      { title: 'B', url: 'https://b.com', content: 'bbb' }
    ])
    // sends POST with bearer auth + max_results
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer k')
    expect(JSON.parse(init.body)).toEqual({ query: 'rust', max_results: 2 })
  })

  it('throws on a non-OK response', async () => {
    process.env.OLLAMA_SEARCH_API_KEY = 'k'
    const { fetchOllamaSearch } = await importFreshModule()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 429, json: async () => ({}) })
    )
    await expect(fetchOllamaSearch('rust', 3)).rejects.toThrow(/429/)
  })

  it('drops results with no url', async () => {
    process.env.OLLAMA_SEARCH_API_KEY = 'k'
    const { fetchOllamaSearch } = await importFreshModule()
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
    const res = await fetchOllamaSearch('rust', 3)
    expect(res).toEqual([{ title: '', url: 'https://y.com', content: '' }])
  })
})
