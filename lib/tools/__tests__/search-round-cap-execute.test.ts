// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The round cap runs INSIDE the search tool's execute. These drive the REAL
// execute (basic SearXNG path, provider stubbed) to pin two things:
// 1. a near-duplicate search that the in-tool dedup skips does NOT consume a
//    round (it used to: the counter was incremented before the dedup check);
// 2. the cap notice past the budget, which in quality mode lets the model
//    keep fetching pages already found but not searching.

const { searxngSearch, embedByQuery } = vi.hoisted(() => ({
  searxngSearch: vi.fn(),
  // Query → embedding. Same vector ⇒ cosine 1 ⇒ near-duplicate.
  embedByQuery: new Map<string, number[]>()
}))

vi.mock('@/lib/embeddings/transformers-embedding', async importOriginal => {
  const actual =
    await importOriginal<
      typeof import('@/lib/embeddings/transformers-embedding')
    >()
  return {
    ...actual,
    getConfiguredModel: () => 'test-embed',
    embedTexts: vi.fn(async (texts: string[]) =>
      texts.map(t => embedByQuery.get(t) ?? [0, 0, 0, 1])
    )
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

import { buildSearchRoundCapNotice, createSearchTool } from '../search'
import {
  buildSearchWithdrawnNote,
  type SearchRoundCounter
} from '../search-rounds'

type Chunk = Record<string, unknown> & { state?: string }

async function runSearch(
  searchTool: ReturnType<typeof createSearchTool>,
  query: string,
  n: number
): Promise<Chunk> {
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
    { toolCallId: `tc-${n}`, messages: [] }
  ) as AsyncIterable<Chunk>
  let last: Chunk = {}
  for await (const chunk of out) last = chunk
  return last
}

function qualityTool(searchRounds?: SearchRoundCounter) {
  return createSearchTool('ollama:test-model', {
    searchMode: 'quality',
    firstSearchDepth: 'basic',
    chatId: 'chat-round-cap-test',
    searchRounds
  })
}

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
  embedByQuery.clear()
  embedByQuery.set('alpha', [1, 0, 0, 0])
  embedByQuery.set('alpha overview', [1, 0, 0, 0])
  embedByQuery.set('beta', [0, 1, 0, 0])
  embedByQuery.set('gamma', [0, 0, 1, 0])
  vi.stubEnv('SEARCH_API', 'searxng')
  vi.stubEnv('SEARCH_DEDUP_ENABLED', 'on')
  vi.stubEnv('SEARCH_ROUNDS_MAX_QUALITY', '2')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('search round cap — dedup-skipped searches do not consume a round', () => {
  it('a near-duplicate skip leaves the round for the next real search', async () => {
    const tool = qualityTool()

    const first = await runSearch(tool, 'alpha', 1)
    expect(first.searchLimitReached).toBeUndefined()

    // Near-duplicate of "alpha": skipped with a note, no provider call.
    const dup = await runSearch(tool, 'alpha overview', 2)
    expect(String(dup.note)).toContain('near-duplicate')
    expect(searxngSearch).toHaveBeenCalledTimes(1)

    // Budget is 2. Before the fix the skip had consumed round 2 and this real
    // search was refused by the cap.
    const second = await runSearch(tool, 'beta', 3)
    expect(second.searchLimitReached).toBeUndefined()
    expect((second.results as unknown[]).length).toBe(1)
    expect(searxngSearch).toHaveBeenCalledTimes(2)

    // The third real search is past the budget.
    const third = await runSearch(tool, 'gamma', 4)
    expect(third.searchLimitReached).toBe(true)
    expect(third.results).toEqual([])
    expect(searxngSearch).toHaveBeenCalledTimes(2)
  })

  it('the cap still counts every search that runs', async () => {
    const tool = qualityTool()
    await runSearch(tool, 'alpha', 1)
    await runSearch(tool, 'beta', 2)
    const third = await runSearch(tool, 'gamma', 3)
    expect(third.searchLimitReached).toBe(true)
    expect(searxngSearch).toHaveBeenCalledTimes(2)
  })

  it('in quality mode the cap notice ends searching but still allows fetch', async () => {
    const tool = qualityTool()
    await runSearch(tool, 'alpha', 1)
    await runSearch(tool, 'beta', 2)
    const capped = await runSearch(tool, 'gamma', 3)
    expect(capped.notice).toBe(buildSearchRoundCapNotice(2, true))
  })

  it('in balanced mode (no fetch cap) the cap notice keeps "answer now"', async () => {
    vi.stubEnv('SEARCH_ROUNDS_MAX', '1')
    const tool = createSearchTool('ollama:test-model', {
      searchMode: 'balanced',
      firstSearchDepth: 'basic',
      chatId: 'chat-round-cap-test'
    })
    await runSearch(tool, 'alpha', 1)
    const capped = await runSearch(tool, 'beta', 2)
    expect(capped.searchLimitReached).toBe(true)
    expect(capped.notice).toBe(buildSearchRoundCapNotice(1, false))
  })

  it("counts into the turn's counter: only searches that actually run", async () => {
    // The researcher reads this counter to stop offering `search` once the
    // budget is spent (lib/agents/search-cap.ts), so it must be the cap's own.
    const rounds: SearchRoundCounter = { used: 0 }
    const tool = qualityTool(rounds)

    await runSearch(tool, 'alpha', 1)
    expect(rounds.used).toBe(1)
    // Near-duplicate skip: no round.
    await runSearch(tool, 'alpha overview', 2)
    expect(rounds.used).toBe(1)
    await runSearch(tool, 'beta', 3)
    expect(rounds.used).toBe(2)
    // Budget 2 spent: the cap refuses, and the refusal is not a round either.
    const capped = await runSearch(tool, 'gamma', 4)
    expect(capped.searchLimitReached).toBe(true)
    expect(rounds.used).toBe(2)
    expect(searxngSearch).toHaveBeenCalledTimes(2)
  })

  it('the cap reads the shared counter, so a spent counter refuses at once', async () => {
    const rounds: SearchRoundCounter = { used: 2 }
    const capped = await runSearch(qualityTool(rounds), 'alpha', 1)
    expect(capped.searchLimitReached).toBe(true)
    expect(searxngSearch).not.toHaveBeenCalled()
  })

  it('the process-wide instance (no toolOptions) is never capped', async () => {
    vi.stubEnv('SEARCH_ROUNDS_MAX', '1')
    const tool = createSearchTool('ollama:test-model')
    await runSearch(tool, 'alpha', 1)
    const second = await runSearch(tool, 'beta', 2)
    expect(second.searchLimitReached).toBeUndefined()
  })
})

describe('buildSearchRoundCapNotice', () => {
  it('with fetch allowed: no more searches, fetch of URLs already found, answer format kept', () => {
    const n = buildSearchRoundCapNotice(10, true)
    expect(n).toContain('Search limit reached (10 rounds)')
    expect(n).toContain('Do not call `search` again')
    expect(n).toContain(
      "You may still call `fetch` on URLs that appeared in this turn's earlier search results"
    )
    expect(n).toContain('begin your reply immediately with its `## ` heading')
    // It must not tell the model to stop all tool use.
    expect(n).not.toContain("Answer the user's question directly now")
  })

  it('without fetch allowed: the answer-now wording, unchanged', () => {
    expect(buildSearchRoundCapNotice(3, false)).toBe(
      "Search limit reached (3 rounds). Answer the user's question directly now using the sources already gathered. Do not search again. Do NOT restate that a limit was reached, do NOT describe what each source gave you, and do NOT narrate that you are stopping or promise another search — begin your reply immediately with its `## ` heading."
    )
  })
})

describe('buildSearchWithdrawnNote', () => {
  it("without fetch allowed: the cap notice's answer-now wording, for a step that no longer offers search", () => {
    expect(buildSearchWithdrawnNote(3, false)).toBe(
      "Search limit reached (3 rounds): `search` is no longer available this turn, and a call to it is refused and returns nothing. Answer the user's question directly now using the sources already gathered. Do NOT restate that a limit was reached, do NOT describe what each source gave you, and do NOT narrate that you are stopping or promise another search — begin your reply immediately with its `## ` heading."
    )
  })

  it('with fetch allowed: no more searches, fetch of URLs already found, answer format kept', () => {
    const n = buildSearchWithdrawnNote(10, true)
    expect(n).toContain('Search limit reached (10 rounds)')
    expect(n).toContain('`search` is no longer available this turn')
    expect(n).toContain(
      "You may still call `fetch` on URLs that appeared in this turn's earlier search results"
    )
    expect(n).toContain('begin your reply immediately with its `## ` heading')
    expect(n).not.toContain("Answer the user's question directly now")
    // Nothing was refused on this step, unlike the cap notice.
    expect(n).not.toContain('this search was not run')
  })
})
