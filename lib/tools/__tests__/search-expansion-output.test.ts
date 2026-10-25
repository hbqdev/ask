// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The first search of a turn also runs the classifier's expansion variants and
// merges their unique URLs into its results. The variant strings used to stop
// there, so the card showed one query for what was up to four. These drive the
// REAL execute (basic SearXNG path, provider stubbed) to pin `expandedQueries`
// on the final output: exactly the variants searched, in order, even when they
// added nothing new — and absent whenever no variants ran.

const { providerSearch } = vi.hoisted(() => ({ providerSearch: vi.fn() }))

vi.mock('@/lib/utils/usage-logging', () => ({ logToolPayload: vi.fn() }))
vi.mock('@/lib/utils/ollama-search-client', () => ({
  fetchOllamaSearch: vi.fn(),
  isOllamaSearchConfigured: () => false
}))
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
    createSearchProvider: () => ({ search: providerSearch })
  }
})

import { createSearchTool, type SearchToolOptions } from '../search'

type Chunk = Record<string, unknown> & { state?: string }

const urlFor = (q: string) => `https://example.com/${encodeURIComponent(q)}`

function tool(expandedQueries?: Promise<string[]>) {
  const options: SearchToolOptions = {
    searchMode: 'balanced',
    firstSearchDepth: 'basic',
    chatId: 'chat-expansion-output-test',
    expandedQueries
  }
  return createSearchTool('ollama:test-model', options)
}

async function runSearch(
  searchTool: ReturnType<typeof createSearchTool>,
  query: string
): Promise<Chunk[]> {
  const out = searchTool.execute!(
    {
      query,
      search_mode: 'web',
      type: 'optimized',
      content_types: ['web'],
      max_results: 10,
      search_depth: 'basic',
      include_domains: [],
      exclude_domains: []
    } as never,
    { toolCallId: `tc-${query}`, messages: [] }
  ) as AsyncIterable<Chunk>
  const yields: Chunk[] = []
  for await (const chunk of out) yields.push(chunk)
  return yields
}

beforeEach(() => {
  providerSearch.mockReset()
  providerSearch.mockImplementation(async (q: string) => ({
    results: [{ title: q, url: urlFor(q), content: 'snippet' }],
    images: [],
    query: q,
    number_of_results: 1
  }))
  vi.stubEnv('SEARCH_API', 'searxng')
  vi.stubEnv('SEARCH_DEDUP_ENABLED', 'off')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('search tool: expandedQueries on the final output', () => {
  it('carries exactly the variants searched, in order, beside the merged results', async () => {
    const yields = await runSearch(
      tool(Promise.resolve(['variant one', 'variant two'])),
      'main query'
    )
    const final = yields.at(-1)!
    expect(final.state).toBe('complete')
    expect(final.expandedQueries).toEqual(['variant one', 'variant two'])
    expect((final.results as Array<{ url: string }>).map(r => r.url)).toEqual([
      urlFor('main query'),
      urlFor('variant one'),
      urlFor('variant two')
    ])
  })

  it('is set even when the variants added no new URLs', async () => {
    // Every query returns the same page, so the merge appends nothing.
    providerSearch.mockImplementation(async (q: string) => ({
      results: [{ title: q, url: 'https://example.com/same', content: 's' }],
      images: [],
      query: q,
      number_of_results: 1
    }))
    const yields = await runSearch(
      tool(Promise.resolve(['variant one'])),
      'main query'
    )
    const final = yields.at(-1)!
    expect(final.results).toHaveLength(1)
    expect(final.expandedQueries).toEqual(['variant one'])
  })

  it('is set even when the variant searches all failed', async () => {
    providerSearch.mockImplementation(async (q: string) => {
      if (q !== 'main query') throw new Error('engine down')
      return {
        results: [{ title: q, url: urlFor(q), content: 's' }],
        images: [],
        query: q,
        number_of_results: 1
      }
    })
    const yields = await runSearch(
      tool(Promise.resolve(['variant one'])),
      'main query'
    )
    expect(yields.at(-1)?.expandedQueries).toEqual(['variant one'])
  })

  it('is absent when the expander returned no variants', async () => {
    const yields = await runSearch(tool(Promise.resolve([])), 'main query')
    expect(yields.at(-1)).not.toHaveProperty('expandedQueries')
    expect(providerSearch).toHaveBeenCalledTimes(1)
  })

  it('is absent when the expander failed', async () => {
    const yields = await runSearch(
      tool(Promise.reject(new Error('classifier down'))),
      'main query'
    )
    expect(yields.at(-1)).not.toHaveProperty('expandedQueries')
  })

  it('is absent when the expander did not answer before the merge wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const pending = runSearch(tool(new Promise<string[]>(() => {})), 'main q')
    await vi.advanceTimersByTimeAsync(12_000)
    const yields = await pending
    expect(yields.at(-1)).not.toHaveProperty('expandedQueries')
    expect(providerSearch).toHaveBeenCalledTimes(1)
  })

  it('is absent when the tool has no expansion at all', async () => {
    const yields = await runSearch(tool(), 'main query')
    expect(yields.at(-1)).not.toHaveProperty('expandedQueries')
  })

  it("is absent on the turn's later searches", async () => {
    const searchTool = tool(Promise.resolve(['variant one']))
    const first = await runSearch(searchTool, 'main query')
    const second = await runSearch(searchTool, 'a different follow-up')
    expect(first.at(-1)?.expandedQueries).toEqual(['variant one'])
    expect(second.at(-1)).not.toHaveProperty('expandedQueries')
  })

  it('never appears on the preliminary searching chunk', async () => {
    const yields = await runSearch(
      tool(Promise.resolve(['variant one'])),
      'main query'
    )
    for (const y of yields.slice(0, -1)) {
      expect(y).not.toHaveProperty('expandedQueries')
    }
  })
})
