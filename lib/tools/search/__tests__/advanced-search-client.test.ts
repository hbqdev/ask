import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/utils/url', () => ({
  getBaseUrlString: async () => 'http://localhost:3000'
}))

import {
  runAdvancedSearch,
  streamAdvancedSearch
} from '../advanced-search-client'

const fetchMock = vi.fn()

function ndjson(lines: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
      }
      controller.close()
    }
  })
  return new Response(body, { status: 200 })
}

function body(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: null,
    json: async () => payload
  } as unknown as Response
}

describe('advanced search client', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.SEARCH_STREAM_PREVIEW
  })

  it('posts to the advanced-search route with the caller parameters', async () => {
    fetchMock.mockResolvedValue(
      body({ results: [{ title: 't', url: 'u', content: 'c' }], query: 'q' })
    )

    await runAdvancedSearch({
      query: 'q',
      maxResults: 20,
      searchDepth: 'advanced',
      timeRange: 'month',
      chatId: 'chat-9',
      useOllama: true,
      ollamaMaxResults: 10,
      stream: false
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/advanced-search')
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      query: 'q',
      maxResults: 20,
      // The whole point: the crawl + rerank pipeline, not a provider call that
      // takes the word 'advanced' and drops it.
      searchDepth: 'advanced',
      timeRange: 'month',
      chatId: 'chat-9',
      useOllama: true,
      stream: false
    })
  })

  it('yields the preview before the final line', async () => {
    // The route knows its candidates ~2s in but does not finish crawling for
    // another 15-20s; the preview is what puts sources on screen meanwhile.
    fetchMock.mockResolvedValue(
      ndjson([
        { type: 'preview', results: [{ title: 'p', url: 'u1', content: '' }] },
        {
          type: 'final',
          results: [{ title: 'f', url: 'u2', content: 'crawled' }],
          query: 'q',
          number_of_results: 1,
          fullResults: [{ title: 'f', url: 'u2', content: 'the whole page' }]
        }
      ])
    )

    const seen = []
    for await (const msg of streamAdvancedSearch({
      query: 'q',
      maxResults: 20,
      searchDepth: 'advanced'
    })) {
      seen.push(msg)
    }

    expect(seen.map(m => m.type)).toEqual(['preview', 'final'])
    expect(seen[1].results.results[0].content).toBe('crawled')
    expect((seen[1] as { fullResults?: unknown[] }).fullResults).toHaveLength(1)
  })

  it('throws when the stream ends without a final line', async () => {
    // "The route died mid-crawl" must never be mistaken for "there was nothing
    // to find" — one is retryable, the other is an answer.
    fetchMock.mockResolvedValue(ndjson([{ type: 'preview', results: [] }]))

    await expect(
      runAdvancedSearch({ query: 'q', maxResults: 20, searchDepth: 'advanced' })
    ).rejects.toThrow(/no final line/)
  })

  it('throws on a non-OK response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable'
    } as Response)

    await expect(
      runAdvancedSearch({ query: 'q', maxResults: 20, searchDepth: 'advanced' })
    ).rejects.toThrow(/503/)
  })

  it('passes the non-streaming body through whole', async () => {
    fetchMock.mockResolvedValue(
      body({
        results: [{ title: 't', url: 'u', content: 'c' }],
        images: ['https://img'],
        query: 'q',
        number_of_results: 1,
        fullResults: [{ title: 't', url: 'u', content: 'full' }]
      })
    )

    const out = await runAdvancedSearch({
      query: 'q',
      maxResults: 20,
      searchDepth: 'advanced',
      stream: false
    })

    expect(out.results.results).toHaveLength(1)
    expect(out.results.images).toEqual(['https://img'])
    expect(out.fullResults).toHaveLength(1)
  })

  it('honours SEARCH_STREAM_PREVIEW=false when the caller has no preference', async () => {
    process.env.SEARCH_STREAM_PREVIEW = 'false'
    fetchMock.mockResolvedValue(body({ results: [], query: 'q' }))

    await runAdvancedSearch({
      query: 'q',
      maxResults: 20,
      searchDepth: 'advanced'
    })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(init.body as string).stream).toBe(false)
  })
})
