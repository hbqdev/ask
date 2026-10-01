// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The in-turn near-duplicate check, driven through the REAL search execute
// (basic SearXNG path, provider stubbed, embedder stubbed). The decision rule
// itself is unit-tested in lib/tools/search/__tests__/query-dedup.test.ts;
// this pins the wiring: the token guard is on by default, an embedder outage
// still catches exact repeats, modes are kept apart, and the legacy switch.

const { searxngSearch, embedTexts } = vi.hoisted(() => ({
  searxngSearch: vi.fn(),
  embedTexts: vi.fn()
}))

vi.mock('@/lib/embeddings/transformers-embedding', async importOriginal => {
  const actual =
    await importOriginal<
      typeof import('@/lib/embeddings/transformers-embedding')
    >()
  return {
    ...actual,
    getConfiguredModel: () => 'test-embed',
    embedTexts
  }
})
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
    createSearchProvider: () => ({ search: searxngSearch })
  }
})

import { createSearchTool } from '../search'

type Chunk = Record<string, unknown> & { state?: string }

async function runSearch(
  searchTool: ReturnType<typeof createSearchTool>,
  query: string,
  n: number,
  searchMode: 'web' | 'academic' = 'web'
): Promise<Chunk> {
  const out = searchTool.execute!(
    {
      query,
      search_mode: searchMode,
      type: 'optimized',
      content_types: ['web'],
      max_results: 10,
      search_depth: 'basic',
      include_domains: [],
      exclude_domains: []
    } as never,
    { toolCallId: `tc-${n}`, messages: [] }
  ) as AsyncIterable<Chunk>
  let last: Chunk = {}
  for await (const chunk of out) last = chunk
  return last
}

function turnTool() {
  return createSearchTool('ollama:test-model', {
    searchMode: 'quality',
    firstSearchDepth: 'basic',
    chatId: 'chat-dedup-test'
  })
}

const isSkip = (chunk: Chunk) =>
  String(chunk.note ?? '').includes('near-duplicate')

const FARFALLE =
  'Farfalle AI search engine GitHub features search backend Tavily SearXNG licensing'
const MORPHIC =
  'Morphic AI search engine GitHub features search backend Tavily SearXNG Exa licensing Apache'

let logs: string[]

beforeEach(() => {
  searxngSearch.mockReset()
  searxngSearch.mockImplementation(async (q: string) => ({
    results: [
      {
        title: q,
        url: `https://example.com/${encodeURIComponent(q)}`,
        content: 'snippet'
      }
    ],
    images: [],
    query: q,
    number_of_results: 1
  }))
  // Every query embeds to the same vector: cosine 1.0, the worst case for a
  // cosine-only rule.
  embedTexts.mockReset()
  embedTexts.mockImplementation(async (texts: string[]) =>
    texts.map(() => [1, 0, 0])
  )
  vi.stubEnv('SEARCH_API', 'searxng')
  vi.stubEnv('SEARCH_DEDUP_ENABLED', 'on')
  logs = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('search execute: near-duplicate check', () => {
  it('runs a templated query about another project even at cosine 1.0', async () => {
    const tool = turnTool()
    await runSearch(tool, FARFALLE, 1)
    const second = await runSearch(tool, MORPHIC, 2)

    expect(isSkip(second)).toBe(false)
    expect(searxngSearch).toHaveBeenCalledTimes(2)
    expect(logs).toContain(
      `[search-dedup] kept "${MORPHIC}" — cos=1.000 to "${FARFALLE}" but adds: morphic, exa, apache`
    )
  })

  it('skips a rephrasing that adds nothing new', async () => {
    const tool = turnTool()
    await runSearch(tool, 'PostgreSQL 18 new features release notes', 1)
    const second = await runSearch(tool, 'PostgreSQL 18 features', 2)

    expect(isSkip(second)).toBe(true)
    expect(second.note).toContain(
      '("PostgreSQL 18 new features release notes")'
    )
    expect(searxngSearch).toHaveBeenCalledTimes(1)
    expect(logs).toContain(
      '[search-dedup] skipping "PostgreSQL 18 features" — near-duplicate of "PostgreSQL 18 new features release notes" (near, cos=1.000)'
    )
  })

  it('catches an exact repeat while the embedder is down', async () => {
    embedTexts.mockRejectedValue(new Error('embedder HTTP 503'))
    const tool = turnTool()
    await runSearch(tool, 'Kidde CO alarm beeping', 1)
    const repeat = await runSearch(tool, '"kidde" co alarm beeping!', 2)
    const other = await runSearch(tool, 'Kidde CO alarm reset button', 3)

    expect(isSkip(repeat)).toBe(true)
    expect(isSkip(other)).toBe(false)
    expect(searxngSearch).toHaveBeenCalledTimes(2)
  })

  it('compares only searches of the same search_mode', async () => {
    const tool = turnTool()
    await runSearch(tool, 'KV cache quantization quality loss', 1, 'web')
    const academic = await runSearch(
      tool,
      'KV cache quantization quality loss',
      2,
      'academic'
    )
    expect(isSkip(academic)).toBe(false)
  })

  it('SEARCH_DEDUP_TOKEN_GUARD=off restores the cosine-only rule', async () => {
    vi.stubEnv('SEARCH_DEDUP_TOKEN_GUARD', 'off')
    const tool = turnTool()
    await runSearch(tool, FARFALLE, 1)
    const second = await runSearch(tool, MORPHIC, 2)
    expect(isSkip(second)).toBe(true)
  })

  it('SEARCH_DEDUP_ENABLED=off never skips', async () => {
    vi.stubEnv('SEARCH_DEDUP_ENABLED', 'off')
    const tool = turnTool()
    await runSearch(tool, 'PostgreSQL 18 features', 1)
    const second = await runSearch(tool, 'PostgreSQL 18 features', 2)
    expect(isSkip(second)).toBe(false)
    expect(embedTexts).not.toHaveBeenCalled()
  })
})
