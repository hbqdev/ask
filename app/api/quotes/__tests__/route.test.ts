import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/quotes/couchbase-quotes')
vi.mock('@/lib/telemetry/latency-store')

import { fetchQuotesFromCouchbase } from '@/lib/quotes/couchbase-quotes'
import { getLatencyRedis } from '@/lib/telemetry/latency-store'

import { GET } from '../route'

function request(url = 'http://localhost:3000/api/quotes') {
  return new Request(url)
}

/** A pool comfortably larger than MAX_BATCH, so the cap is what does the capping. */
function bigPool(size = 150) {
  return Array.from({ length: size }, (_, i) => ({
    q: `Quote number ${i}.`,
    a: `Author ${i}`
  }))
}

function texts(quotes: { q: string }[]) {
  return quotes.map(quote => quote.q)
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  // The degradation paths log; keep the run readable. Restored per test rather
  // than left in place so the stub cannot leak into another file's console.
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(getLatencyRedis).mockResolvedValue(null as never)
  vi.mocked(fetchQuotesFromCouchbase).mockResolvedValue([])
})

afterEach(() => {
  warn.mockRestore()
})

describe('GET /api/quotes', () => {
  it('serves the bundled fallback when Couchbase and Redis are both unavailable', async () => {
    const res = await GET(request())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.quotes.length).toBeGreaterThan(0)
    expect(typeof body.quotes[0].q).toBe('string')
    expect(typeof body.quotes[0].a).toBe('string')
  })

  it('serves the cached pool without touching Couchbase when Redis has one', async () => {
    vi.mocked(getLatencyRedis).mockResolvedValue({
      get: async () => JSON.stringify([{ q: 'Cached.', a: 'Redis' }]),
      set: async () => undefined
    } as never)

    const res = await GET(request())
    const body = await res.json()

    expect(body.quotes).toEqual([{ q: 'Cached.', a: 'Redis' }])
    expect(fetchQuotesFromCouchbase).not.toHaveBeenCalled()
  })

  it('fetches and caches when Redis is empty', async () => {
    const set = vi.fn(async () => undefined)
    vi.mocked(getLatencyRedis).mockResolvedValue({
      get: async () => null,
      set
    } as never)
    vi.mocked(fetchQuotesFromCouchbase).mockResolvedValue([
      { q: 'Fresh.', a: 'Couchbase' }
    ])

    const res = await GET(request())
    const body = await res.json()

    expect(body.quotes).toEqual([{ q: 'Fresh.', a: 'Couchbase' }])
    expect(set).toHaveBeenCalled()
  })

  it('caps the batch size so a caller cannot ask for the whole pool', async () => {
    // The pool has to exceed the cap for this to test anything: against the
    // 22-entry bundled set every batch is under 100 whatever the cap does.
    vi.mocked(fetchQuotesFromCouchbase).mockResolvedValue(bigPool())

    const res = await GET(request('http://localhost:3000/api/quotes?n=9999'))
    const body = await res.json()

    expect(body.quotes).toHaveLength(100)
  })

  it('serves the default batch when no count is asked for', async () => {
    vi.mocked(fetchQuotesFromCouchbase).mockResolvedValue(bigPool())

    const body = await (await GET(request())).json()

    expect(body.quotes).toHaveLength(40)
  })

  it.each(['abc', '-5', '0', '', 'Infinity'])(
    'falls back to the default batch for n=%s',
    async value => {
      vi.mocked(fetchQuotesFromCouchbase).mockResolvedValue(bigPool())

      const res = await GET(
        request(`http://localhost:3000/api/quotes?n=${value}`)
      )

      expect((await res.json()).quotes).toHaveLength(40)
    }
  )

  it('returns the whole pool without repeats when it is smaller than the batch', async () => {
    // Bundled set is 22 entries against a default batch of 40; the window must
    // stop at the end of the pool rather than wrapping into a repeat.
    const body = await (await GET(request())).json()

    expect(body.quotes.length).toBeGreaterThan(0)
    expect(body.quotes.length).toBeLessThan(40)
    expect(new Set(texts(body.quotes)).size).toBe(body.quotes.length)
  })

  it('never 500s, even when Redis itself throws', async () => {
    vi.mocked(getLatencyRedis).mockRejectedValue(new Error('redis down'))
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect((await res.json()).quotes.length).toBeGreaterThan(0)
  })

  it('degrades and repopulates when the cached value is not valid JSON', async () => {
    const set = vi.fn(async () => undefined)
    vi.mocked(getLatencyRedis).mockResolvedValue({
      get: async () => '{"quotes":[', // truncated write
      set
    } as never)
    vi.mocked(fetchQuotesFromCouchbase).mockResolvedValue([
      { q: 'Fresh.', a: 'Couchbase' }
    ])

    const res = await GET(request())

    expect(res.status).toBe(200)
    expect((await res.json()).quotes).toEqual([{ q: 'Fresh.', a: 'Couchbase' }])
    // The corrupt entry is overwritten rather than left to poison the next 24h.
    expect(set).toHaveBeenCalled()
  })

  it('does not forward malformed entries from the cache to the client', async () => {
    vi.mocked(getLatencyRedis).mockResolvedValue({
      get: async () =>
        JSON.stringify([
          42,
          null,
          { q: '   ', a: 'Blank' },
          { q: 'Good.', a: 'Cached' }
        ]),
      set: async () => undefined
    } as never)

    const body = await (await GET(request())).json()

    expect(body.quotes).toEqual([{ q: 'Good.', a: 'Cached' }])
  })

  it('falls through to Couchbase when the cache holds nothing usable', async () => {
    vi.mocked(getLatencyRedis).mockResolvedValue({
      get: async () => JSON.stringify([1, 2, 3]),
      set: async () => undefined
    } as never)
    vi.mocked(fetchQuotesFromCouchbase).mockResolvedValue([
      { q: 'Fresh.', a: 'Couchbase' }
    ])

    const body = await (await GET(request())).json()

    expect(body.quotes).toEqual([{ q: 'Fresh.', a: 'Couchbase' }])
  })

  it('falls through to Couchbase when the client has no get method', async () => {
    // getLatencyRedis is typed for list ops only; a dialect without get must
    // degrade, not throw.
    vi.mocked(getLatencyRedis).mockResolvedValue({ lPush: vi.fn() } as never)
    vi.mocked(fetchQuotesFromCouchbase).mockResolvedValue([
      { q: 'Fresh.', a: 'Couchbase' }
    ])

    const res = await GET(request())

    expect(res.status).toBe(200)
    expect((await res.json()).quotes).toEqual([{ q: 'Fresh.', a: 'Couchbase' }])
  })

  it('still serves the fresh pool when writing the cache fails', async () => {
    vi.mocked(getLatencyRedis).mockResolvedValue({
      get: async () => null,
      set: async () => {
        throw new Error('OOM command not allowed')
      }
    } as never)
    vi.mocked(fetchQuotesFromCouchbase).mockResolvedValue([
      { q: 'Fresh.', a: 'Couchbase' }
    ])

    const res = await GET(request())

    expect(res.status).toBe(200)
    expect((await res.json()).quotes).toEqual([{ q: 'Fresh.', a: 'Couchbase' }])
  })

  it('does not cache the bundled set, so an outage cannot pin it for a day', async () => {
    const set = vi.fn(async () => undefined)
    vi.mocked(getLatencyRedis).mockResolvedValue({
      get: async () => null,
      set
    } as never)
    vi.mocked(fetchQuotesFromCouchbase).mockResolvedValue([])

    const body = await (await GET(request())).json()

    expect(body.quotes.length).toBeGreaterThan(0)
    expect(set).not.toHaveBeenCalled()
  })

  it('holds no pool across requests, so a changed source is seen immediately', async () => {
    vi.mocked(getLatencyRedis).mockResolvedValue({
      get: async () => JSON.stringify([{ q: 'First.', a: 'Redis' }]),
      set: async () => undefined
    } as never)
    const first = await (await GET(request())).json()

    vi.mocked(getLatencyRedis).mockResolvedValue({
      get: async () => JSON.stringify([{ q: 'Second.', a: 'Redis' }]),
      set: async () => undefined
    } as never)
    const second = await (await GET(request())).json()

    expect(first.quotes).toEqual([{ q: 'First.', a: 'Redis' }])
    expect(second.quotes).toEqual([{ q: 'Second.', a: 'Redis' }])
  })

  it('returns only the quotes, never anything about the source', async () => {
    vi.mocked(fetchQuotesFromCouchbase).mockResolvedValue(bigPool(5))

    const body = await (await GET(request())).json()

    expect(Object.keys(body)).toEqual(['quotes'])
  })
})
