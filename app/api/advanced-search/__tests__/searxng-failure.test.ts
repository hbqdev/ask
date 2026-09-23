// @vitest-environment node
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'

const redisSet = vi.fn(async () => 'OK')

vi.mock('redis', () => ({
  createClient: () => ({
    connect: async () => {},
    get: async () => null,
    set: redisSet,
    keys: async () => [],
    ttl: async () => -1,
    del: async () => 0
  })
}))
vi.mock('@/lib/utils/ingest-auth', () => ({
  checkIngestAuth: () => ({ ok: true })
}))
vi.mock('@/lib/utils/searxng-client', () => ({
  fetchSearxngJson: vi.fn()
}))
vi.mock('@/lib/utils/ollama-search-client', () => ({
  fetchOllamaSearch: vi.fn()
}))
vi.mock('@/lib/utils/degoog-client', () => ({
  fetchDegoogJson: vi.fn(async () => null)
}))

import { fetchOllamaSearch } from '@/lib/utils/ollama-search-client'
import { fetchSearxngJson } from '@/lib/utils/searxng-client'

import { resolveSearxngContribution } from '../searxng-contribution'

const OLLAMA_HITS = [
  {
    title: 'Ollama hit one',
    url: 'https://example.com/one',
    content: 'full page body one'
  },
  {
    title: 'Ollama hit two',
    url: 'https://example.org/two',
    content: 'full page body two'
  }
]

const req = (body: Record<string, unknown>) =>
  new Request('http://x/api/advanced-search', {
    method: 'POST',
    headers: { authorization: 'Bearer t' },
    body: JSON.stringify(body)
  })

describe('resolveSearxngContribution', () => {
  it('turns a rejected SearXNG fetch into an empty, failed contribution', () => {
    const out = resolveSearxngContribution(
      { status: 'rejected', reason: new Error('both down') },
      'q'
    )
    expect(out.status).toBe('failed')
    expect(out.data).toEqual({ results: [], query: 'q', number_of_results: 0 })
  })

  it('treats a malformed body as a failure, not a throw', () => {
    const out = resolveSearxngContribution(
      { status: 'fulfilled', value: { data: { nope: 1 }, baseUrlUsed: 'u' } },
      'q'
    )
    expect(out.status).toBe('failed')
    expect(out.data.results).toEqual([])
  })

  it('marks an unfired slot (balanced mode) as skipped', () => {
    const out = resolveSearxngContribution(
      { status: 'fulfilled', value: null },
      'q'
    )
    expect(out.status).toBe('skipped')
  })

  it('passes a good response through with its base URL', () => {
    const data = { results: [{ url: 'https://a' }], query: 'q' }
    const out = resolveSearxngContribution(
      { status: 'fulfilled', value: { data, baseUrlUsed: 'http://sx' } },
      'q'
    )
    expect(out).toMatchObject({ status: 'ok', apiUrl: 'http://sx', data })
  })
})

describe('POST /api/advanced-search when SearXNG fails', () => {
  // The route module is heavy (jsdom, readability); import it once, with room
  // for a loaded machine, rather than per test.
  let POST: typeof import('../route').POST
  beforeAll(async () => {
    ;({ POST } = await import('../route'))
  }, 60_000)
  beforeEach(() => {
    redisSet.mockClear()
    vi.mocked(fetchSearxngJson).mockRejectedValue(
      new Error('primary and fallback both down')
    )
    vi.mocked(fetchOllamaSearch).mockResolvedValue(OLLAMA_HITS)
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the other providers results instead of returning an empty search', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await POST(
      req({
        query: 'unique failing query',
        maxResults: 5,
        searchDepth: 'basic',
        useOllama: true,
        ollamaMaxResults: 5
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.map((r: { url: string }) => r.url)).toEqual(
      expect.arrayContaining(OLLAMA_HITS.map(h => h.url))
    )
    // The failure is logged, not swallowed silently.
    expect(warn.mock.calls.some(c => String(c[0]).includes('[searxng]'))).toBe(
      true
    )
    // A SearXNG-less (degraded) result is returned but never cached.
    expect(redisSet).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('still caches a healthy result', async () => {
    vi.mocked(fetchSearxngJson).mockResolvedValue({
      data: {
        results: [{ title: 'sx', url: 'https://sx.example/a', content: 'c' }],
        query: 'q',
        number_of_results: 1
      },
      baseUrlUsed: 'http://searxng'
    })
    const res = await POST(
      req({
        query: 'unique healthy query',
        maxResults: 5,
        searchDepth: 'basic',
        useOllama: true
      })
    )
    const body = await res.json()
    expect(body.results.length).toBeGreaterThan(0)
    expect(redisSet).toHaveBeenCalledTimes(1)
  })
})
