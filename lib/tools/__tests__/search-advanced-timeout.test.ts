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

// The search tool's internal POST to /api/advanced-search had no timeout. On
// 2026-09-27 the route (wedged Redis client) never sent headers and every
// balanced/quality first search hung for 300s. These run the REAL execute()
// against a local route that never answers, and pin that the turn instead
// falls back to the basic SearXNG path within the configured limit.

const { baseUrl, searxngSearch } = vi.hoisted(() => ({
  baseUrl: { value: '' },
  searxngSearch: vi.fn()
}))

vi.mock('@/lib/utils/url', () => ({
  getBaseUrlString: async () => baseUrl.value
}))
vi.mock('@/lib/utils/usage-logging', () => ({ logToolPayload: vi.fn() }))
vi.mock('@/lib/utils/ollama-search-client', () => ({
  fetchOllamaSearch: vi.fn(),
  isOllamaSearchConfigured: () => false
}))
// In-memory basic cache: the real helper, without a Redis connection.
vi.mock('@/lib/search/basic-search-cache', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@/lib/search/basic-search-cache')>()
  return {
    ...actual,
    redisCacheIO: { get: async () => null, set: async () => {} }
  }
})
vi.mock('../search/providers', async importOriginal => {
  const actual = await importOriginal<typeof import('../search/providers')>()
  return {
    ...actual,
    createSearchProvider: () => ({ search: searxngSearch })
  }
})

import { createSearchTool } from '../search'

const BASIC = {
  results: [
    { title: 'Basic hit', url: 'https://basic.example/a', content: 'snippet' }
  ],
  images: [],
  query: 'q',
  number_of_results: 1
}

let server: http.Server
const open = new Set<http.ServerResponse>()
let routeHits = 0

beforeAll(async () => {
  server = http.createServer((req, res) => {
    open.add(res)
    res.on('close', () => open.delete(res))
    if (req.url === '/api/advanced-search') {
      routeHits += 1
      return // never answers — the 2026-09-27 hang
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
  routeHits = 0
  searxngSearch.mockReset()
  searxngSearch.mockResolvedValue(BASIC)
  vi.stubEnv('SEARCH_API', 'searxng')
  vi.stubEnv('SEARCH_DEDUP_ENABLED', 'off')
  vi.stubEnv('SEARCH_STREAM_PREVIEW', 'true')
  vi.stubEnv('ADVANCED_SEARCH_HEADERS_TIMEOUT_MS', '150')
  vi.stubEnv('ADVANCED_SEARCH_TIMEOUT_MS', '3000')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function runFirstSearch(abortSignal?: AbortSignal) {
  const searchTool = createSearchTool('ollama:test-model', {
    searchMode: 'balanced',
    firstSearchDepth: 'advanced',
    chatId: 'chat-timeout-test'
  })
  const out = searchTool.execute!(
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
    { toolCallId: 'tc-timeout', messages: [], abortSignal }
  ) as AsyncIterable<Record<string, unknown>>
  const yields: Record<string, unknown>[] = []
  for await (const y of out) yields.push(y)
  return yields
}

describe('search tool: advanced-search that never responds', () => {
  it('falls back to basic SearXNG within the headers limit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const started = Date.now()
    const yields = await runFirstSearch()
    const elapsed = Date.now() - started

    // It really went to the route first (the balanced first search)...
    expect(routeHits).toBe(1)
    // ...gave up on it in bounded time instead of 300s...
    expect(elapsed).toBeLessThan(2500)
    // ...and answered from the basic SearXNG path, at basic depth.
    expect(searxngSearch).toHaveBeenCalledTimes(1)
    expect(searxngSearch.mock.calls[0][2]).toBe('basic')
    const final = yields.at(-1)!
    expect(final.state).toBe('complete')
    expect(final.results).toEqual(BASIC.results)
    expect(final.toolCallId).toBe('tc-timeout')
    // The operator-facing line the runbook greps for.
    expect(
      warn.mock.calls.some(c =>
        String(c[0]).startsWith('[search] advanced-search timed out')
      )
    ).toBe(true)
    // The tool owns the telemetry line for the fallback search.
    const logged = vi
      .mocked(console.log)
      .mock.calls.map(c => String(c[0]))
      .find(l => l.startsWith('[latency:search]'))
    expect(logged).toContain('"kind":"advanced-fallback"')
    expect(logged).toContain('"advanced_timeout":"headers"')
  })

  it('a user stop is still an abort, not a silent fallback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const turn = new AbortController()
    setTimeout(() => turn.abort(new Error('user stopped')), 50)
    await expect(runFirstSearch(turn.signal)).rejects.toThrow()
    expect(searxngSearch).not.toHaveBeenCalled()
  })
})
