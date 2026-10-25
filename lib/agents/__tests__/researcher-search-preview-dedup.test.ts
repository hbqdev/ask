// @vitest-environment node
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'

// The streamed advanced search yields a UI-only `preview` chunk (state
// 'complete') before the crawled+reranked final chunk, and the model reads
// only the final one. wrapSearchToolWithDedup used to record the preview's
// URLs as "already returned", so the final chunk lost them with a "N of M
// result(s) were already returned earlier" notice — on the turn's FIRST
// search. These pin: preview chunks pass through untouched and record
// nothing; dedup across DIFFERENT searches still works.

const { baseUrl, ndjsonLines } = vi.hoisted(() => ({
  baseUrl: { value: '' },
  ndjsonLines: { value: [] as unknown[] }
}))

vi.mock('@/lib/utils/url', () => ({
  getBaseUrlString: async () => baseUrl.value
}))
vi.mock('@/lib/utils/usage-logging', () => ({ logToolPayload: vi.fn() }))
vi.mock('@/lib/utils/ollama-search-client', () => ({
  fetchOllamaSearch: vi.fn(),
  isOllamaSearchConfigured: () => false
}))
vi.mock('@/lib/memory/inject', () => ({
  getMemoryInjection: vi.fn(async () => '')
}))

import { createSearchTool } from '@/lib/tools/search'

import { wrapSearchToolWithDedup } from '../researcher'

type Chunk = Record<string, unknown> & {
  state?: string
  results?: Array<{ url?: string }>
}

const item = (letter: string) => ({
  title: `Result ${letter}`,
  url: `https://example.com/${letter}`,
  content: `content for ${letter} `.repeat(20)
})

function fakeSearchTool(perCall: Chunk[][]) {
  let call = 0
  return {
    description: 'fake search tool',
    inputSchema: {} as any,
    toModelOutput: undefined,
    async *execute() {
      for (const chunk of perCall[call++] ?? []) yield chunk
    }
  } as any
}

async function collect(t: any, query: string): Promise<Chunk[]> {
  const out: Chunk[] = []
  for await (const c of t.execute({ query }, { toolCallId: query }))
    out.push(c as Chunk)
  return out
}

const urls = (c: Chunk | undefined) => (c?.results ?? []).map(r => r.url)

describe('wrapSearchToolWithDedup: preview chunks', () => {
  it('passes a preview chunk through unchanged and does not record its URLs', async () => {
    const preview: Chunk = {
      state: 'complete',
      preview: true,
      results: [item('A'), item('B'), item('C')],
      images: [],
      query: 'q1',
      number_of_results: 3
    }
    const final: Chunk = {
      state: 'complete',
      results: [item('A'), item('B'), item('D')],
      images: [],
      query: 'q1',
      number_of_results: 3
    }
    const seenUrls = new Set<string>()
    const wrapped = wrapSearchToolWithDedup(
      fakeSearchTool([[preview, final]]),
      seenUrls,
      new Map()
    )
    const chunks = await collect(wrapped, 'q1')

    expect(chunks).toHaveLength(2)
    // Same object, flag kept: nothing rewritten.
    expect(chunks[0]).toBe(preview)
    expect(chunks[0].preview).toBe(true)
    // The final chunk — the only one the model reads — is whole.
    expect(urls(chunks[1])).toEqual([
      'https://example.com/A',
      'https://example.com/B',
      'https://example.com/D'
    ])
    expect(chunks[1].notice).toBeUndefined()
    expect(chunks[1].deduped).toBeUndefined()
    // Only URLs the model received count as returned (C was preview-only).
    expect([...seenUrls].sort()).toEqual([
      'https://example.com/A',
      'https://example.com/B',
      'https://example.com/D'
    ])
  })

  it('still strips a URL the model already received from an earlier search, with the notice', async () => {
    const wrapped = wrapSearchToolWithDedup(
      fakeSearchTool([
        [
          {
            state: 'complete',
            preview: true,
            results: [item('A'), item('X')],
            images: [],
            query: 'q1'
          },
          {
            state: 'complete',
            results: [item('A'), item('B')],
            images: [],
            query: 'q1'
          }
        ],
        [
          {
            state: 'complete',
            preview: true,
            results: [item('B'), item('C')],
            images: [],
            query: 'q2'
          },
          {
            state: 'complete',
            results: [item('B'), item('C'), item('X')],
            images: [],
            query: 'q2'
          }
        ]
      ]),
      new Set(),
      new Map()
    )
    const first = await collect(wrapped, 'first query')
    const second = await collect(wrapped, 'second different query')

    expect(first.at(-1)?.notice).toBeUndefined()
    // The second search's preview is untouched (B still shown in the UI)...
    expect(urls(second[0])).toEqual([
      'https://example.com/B',
      'https://example.com/C'
    ])
    // ...its final drops B (received from search 1) but keeps X, which only
    // ever appeared in search 1's PREVIEW and so was never returned.
    expect(urls(second.at(-1))).toEqual([
      'https://example.com/C',
      'https://example.com/X'
    ])
    expect(second.at(-1)?.deduped).toBe(1)
    expect(String(second.at(-1)?.notice)).toContain(
      '1 of 3 result(s) were already returned earlier in this turn'
    )
  })
})

// The REAL search tool against a local /api/advanced-search that streams
// NDJSON, wrapped exactly as the researcher wraps it.
let server: http.Server
const open = new Set<http.ServerResponse>()

beforeAll(async () => {
  server = http.createServer((req, res) => {
    open.add(res)
    res.on('close', () => open.delete(res))
    if (req.url === '/api/advanced-search') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      for (const line of ndjsonLines.value)
        res.write(`${JSON.stringify(line)}\n`)
      res.end()
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  baseUrl.value = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  for (const res of open) res.destroy()
  server.closeAllConnections()
  await new Promise<void>(r => server.close(() => r()))
})

beforeEach(() => {
  vi.stubEnv('SEARCH_API', 'searxng')
  vi.stubEnv('SEARCH_DEDUP_ENABLED', 'off')
  vi.stubEnv('SEARCH_STREAM_PREVIEW', 'true')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('streamed advanced search through the dedup wrapper', () => {
  it("the turn's first search reaches the model whole: preview A,B,C then final A,B,D", async () => {
    ndjsonLines.value = [
      {
        type: 'preview',
        results: [item('A'), item('B'), item('C')],
        number_of_results: 3
      },
      {
        type: 'final',
        results: [item('A'), item('B'), item('D')],
        query: 'nvidia rtx 5090 price',
        images: [],
        number_of_results: 3
      }
    ]
    const searchTool = createSearchTool('ollama:test-model', {
      searchMode: 'balanced',
      firstSearchDepth: 'advanced',
      chatId: 'chat-preview-dedup-test'
    })
    const wrapped = wrapSearchToolWithDedup(searchTool, new Set(), new Map())
    const out = wrapped.execute!(
      {
        query: 'nvidia rtx 5090 price',
        search_mode: 'web',
        type: 'optimized',
        content_types: ['web'],
        max_results: 10,
        search_depth: 'advanced',
        include_domains: [],
        exclude_domains: []
      } as never,
      { toolCallId: 'tc-preview', messages: [] }
    ) as AsyncIterable<Chunk>
    const yields: Chunk[] = []
    for await (const y of out) yields.push(y)

    // AI SDK v6 hands the model only the LAST yield.
    const final = yields.at(-1)
    expect(final?.preview).toBeUndefined()
    expect(urls(final)).toEqual([
      'https://example.com/A',
      'https://example.com/B',
      'https://example.com/D'
    ])
    expect(final?.notice).toBeUndefined()
    expect(final?.deduped).toBeUndefined()

    const preview = yields.find(y => y.preview === true)
    expect(preview).toBeDefined()
    expect(preview?.state).toBe('complete')
    expect(urls(preview)).toEqual([
      'https://example.com/A',
      'https://example.com/B',
      'https://example.com/C'
    ])
  })
})
