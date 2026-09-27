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

// 2026-09-27: after the redis sidecar was recreated, this route's cache GET
// never settled (wedged client + offline queue), so the route never sent
// response headers and every balanced/quality first search hung for 300s.
// These pin that a Redis that never answers is now a cache MISS in bounded
// time, and that the GET probe the fleet update uses reports it.

const redis = vi.hoisted(() => ({
  hang: false,
  get: vi.fn(),
  set: vi.fn(),
  ping: vi.fn()
}))

vi.mock('redis', () => ({
  createClient: () => ({
    on: () => {},
    isOpen: true,
    isReady: true,
    connect: async () => {},
    disconnect: async () => {},
    get: (...a: unknown[]) =>
      redis.hang ? new Promise(() => {}) : redis.get(...a),
    set: (...a: unknown[]) =>
      redis.hang ? new Promise(() => {}) : redis.set(...a),
    ping: () => (redis.hang ? new Promise(() => {}) : redis.ping()),
    keys: async () => [],
    ttl: async () => -1,
    del: async () => 0
  })
}))
vi.mock('@/lib/utils/ingest-auth', () => ({
  checkIngestAuth: (h: string | null) =>
    h === 'Bearer t' ? { ok: true } : { ok: false, status: 401 }
}))
vi.mock('@/lib/utils/searxng-client', () => ({
  fetchSearxngJson: vi.fn(async () => ({
    data: {
      results: [{ title: 'sx', url: 'https://sx.example/a', content: 'c' }],
      query: 'q',
      number_of_results: 1
    },
    baseUrlUsed: 'http://searxng'
  }))
}))
vi.mock('@/lib/utils/ollama-search-client', () => ({
  fetchOllamaSearch: vi.fn(async () => [])
}))
vi.mock('@/lib/utils/degoog-client', () => ({
  fetchDegoogJson: vi.fn(async () => null)
}))

const auth = { authorization: 'Bearer t' }

describe('advanced-search route vs. a Redis that never answers', () => {
  let GET: typeof import('../route').GET
  let POST: typeof import('../route').POST
  beforeAll(async () => {
    vi.stubEnv('LOCAL_REDIS_COMMAND_TIMEOUT_MS', '100')
    ;({ GET, POST } = await import('../route'))
  }, 60_000)
  beforeEach(() => {
    redis.hang = false
    redis.get.mockResolvedValue(null)
    redis.set.mockResolvedValue('OK')
    redis.ping.mockResolvedValue('PONG')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('GET probe: 200 redis:ok through the route’s own client', async () => {
    const res = await GET(
      new Request('http://x/api/advanced-search', { headers: auth })
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      redis: 'ok',
      backend: 'local'
    })
  })

  it('GET probe: rejects callers without the internal token', async () => {
    const res = await GET(new Request('http://x/api/advanced-search'))
    expect(res.status).toBe(401)
  })

  it('GET probe: 503 in bounded time when Redis never answers', async () => {
    redis.hang = true
    const started = Date.now()
    const res = await GET(
      new Request('http://x/api/advanced-search', { headers: auth })
    )
    expect(Date.now() - started).toBeLessThan(2000)
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({ redis: 'error' })
  })

  it('POST (stream): headers + final line arrive — the cache is a miss, not a hang', async () => {
    redis.hang = true
    const started = Date.now()
    const res = await POST(
      new Request('http://x/api/advanced-search', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          query: 'redis hang regression',
          maxResults: 5,
          searchDepth: 'basic',
          stream: true
        })
      })
    )
    expect(res.status).toBe(200)
    const lines = (await res.text())
      .trim()
      .split('\n')
      .map(l => JSON.parse(l))
    expect(Date.now() - started).toBeLessThan(5000)
    const final = lines.find(l => l.type === 'final')
    expect(final?.results?.length).toBeGreaterThan(0)
    expect(final?.timings?.cache_ms).toBeLessThan(2000)
  })
})
