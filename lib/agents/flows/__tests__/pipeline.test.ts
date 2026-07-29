import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SearchResults } from '@/lib/types'
import type { UIMessage } from '@/lib/types/ai'
import { extractCitationMaps, processCitations } from '@/lib/utils/citation'

import {
  buildRetrievalToolPart,
  buildSourceBlock,
  type PipelineRetrieval,
  shouldInjectRetrieval,
  startSpeculativeRetrieval
} from '../pipeline'

// Hoisted so the mock factories (which vitest lifts above the imports) can
// close over these without a TDZ error.
const { runAdvancedSearch, providerSearch } = vi.hoisted(() => ({
  runAdvancedSearch: vi.fn(),
  providerSearch: vi.fn()
}))

// The retrieval must go through /api/advanced-search — crawl, snippet gate and
// cross-encoder rerank — not through a provider call that merely takes the
// string 'advanced' as an argument and ignores it.
vi.mock('@/lib/tools/search/advanced-search-client', () => ({
  runAdvancedSearch,
  resolveOllamaSearchOptions: () => ({ useOllama: true, ollamaMaxResults: 10 })
}))

vi.mock('@/lib/tools/search/providers', () => ({
  createSearchProvider: () => ({ search: providerSearch })
}))

function results(n: number): SearchResults {
  return {
    query: 'q',
    images: [],
    number_of_results: n,
    results: Array.from({ length: n }, (_, i) => ({
      title: `Result ${i + 1}`,
      url: `https://example${i + 1}.com/page`,
      content: `content ${i + 1}`
    }))
  }
}

function retrieval(over: Partial<PipelineRetrieval> = {}): PipelineRetrieval {
  return {
    query: 'postgres 18.4 release notes',
    results: results(3),
    ms: 1200,
    toolCallId: 'pipelineCall123',
    ...over
  }
}

// This predicate exists to be shared, not to be clever: the researcher gates
// on it and the turn telemetry reports it. When the gate was inline and the
// telemetry reported the speculative retrieval's own result count instead, a
// run where the gate declined on 9 of 16 probes was recorded as 16/16
// searched — and the classifier was blamed for it.
describe('shouldInjectRetrieval', () => {
  it('injects only a turn that is both searchable and time-sensitive', () => {
    expect(
      shouldInjectRetrieval({ skipSearch: false, needsRecent: true })
    ).toBe(true)
  })

  it('declines a turn answerable from the conversation itself', () => {
    expect(shouldInjectRetrieval({ skipSearch: true, needsRecent: true })).toBe(
      false
    )
  })

  it('declines a settled-knowledge turn asked fresh', () => {
    // "What is the difference between TCP and UDP" — not in the conversation,
    // so skipSearch is false, but nothing about it changes month to month.
    expect(
      shouldInjectRetrieval({ skipSearch: false, needsRecent: false })
    ).toBe(false)
  })

  it('declines when both signals say no', () => {
    expect(
      shouldInjectRetrieval({ skipSearch: true, needsRecent: false })
    ).toBe(false)
  })
})

describe('startSpeculativeRetrieval', () => {
  beforeEach(() => {
    runAdvancedSearch.mockReset()
    providerSearch.mockReset()
  })

  afterEach(() => {
    delete process.env.SEARCH_API
  })

  it('routes through the advanced pipeline, not a bare provider search', async () => {
    runAdvancedSearch.mockResolvedValue({ results: results(5) })

    const r = await startSpeculativeRetrieval('who won the election', {
      chatId: 'chat-1'
    })

    expect(runAdvancedSearch).toHaveBeenCalledTimes(1)
    expect(runAdvancedSearch.mock.calls[0][0]).toMatchObject({
      query: 'who won the election',
      searchDepth: 'advanced',
      maxResults: 20,
      chatId: 'chat-1',
      // Retrieval fires before the UI stream exists, so there is nowhere to
      // render a preview line.
      stream: false,
      useOllama: true
    })
    expect(r.results?.results).toHaveLength(5)
    expect(r.toolCallId).toBeTruthy()
  })

  it('leaves a non-searxng deployment on its configured provider', async () => {
    // /api/advanced-search IS SearXNG. Sending a Tavily/Exa deployment there
    // would silently swap out its configured provider, or 500 on a host with
    // no SearXNG at all.
    process.env.SEARCH_API = 'tavily'
    providerSearch.mockResolvedValue(results(3))

    const r = await startSpeculativeRetrieval('anything')

    expect(runAdvancedSearch).not.toHaveBeenCalled()
    expect(providerSearch).toHaveBeenCalledTimes(1)
    expect(r.results?.results).toHaveLength(3)
  })

  it('retries exactly once when the first pass comes back empty', async () => {
    // Measured: 7 of 16 probes retrieved zero sources at ~4000ms, which is
    // searxng's request_timeout. The loop recovered by searching again; with
    // the loop gone that recovery has to be code.
    runAdvancedSearch
      .mockResolvedValueOnce({ results: results(0) })
      .mockResolvedValueOnce({ results: results(4) })

    const r = await startSpeculativeRetrieval('current postgres version')

    expect(runAdvancedSearch).toHaveBeenCalledTimes(2)
    expect(r.results?.results).toHaveLength(4)
  })

  it('does not retry when the first pass returns results', async () => {
    runAdvancedSearch.mockResolvedValue({ results: results(2) })
    await startSpeculativeRetrieval('anything')
    expect(runAdvancedSearch).toHaveBeenCalledTimes(1)
  })

  it('never rejects when the advanced path throws', async () => {
    // A failed retrieval degrades to an unsourced answer. It must not take the
    // turn down: this architecture has no second chance by construction.
    runAdvancedSearch.mockRejectedValue(new Error('crawl4ai is down'))

    const r = await startSpeculativeRetrieval('anything')

    expect(r.results).toBeNull()
    expect(r.error).toContain('crawl4ai is down')
    expect(r.toolCallId).toBeTruthy()
  })

  it('short-circuits an empty query without searching', async () => {
    const r = await startSpeculativeRetrieval('   ')
    expect(runAdvancedSearch).not.toHaveBeenCalled()
    expect(r.results).toBeNull()
    expect(r.toolCallId).toBeTruthy()
  })
})

describe('buildSourceBlock', () => {
  it('cancels the loop prompts mandate to call a tool this turn does not have', () => {
    // The base prompts say the FIRST action of every turn MUST be `search`.
    // Under the pipeline `search` is removed from activeTools, so an
    // uncancelled mandate orders the model to do the impossible.
    const block = buildSourceBlock(retrieval())
    expect(block).toMatch(/REMOVED from your tools/i)
    expect(block).toMatch(/does NOT apply to this turn/i)
  })

  it('states exactly one citation format, the resolvable one', () => {
    const block = buildSourceBlock(retrieval())
    // The anchor form is what processCitations understands; a bare [1] is left
    // as literal text by every consumer.
    expect(block).toContain('[N](#pipelineCall123)')
    expect(block).not.toMatch(/Cite them inline as \[1\], \[2\]/)
  })

  it('numbers sources from 1 in the order the tool part will carry them', () => {
    const block = buildSourceBlock(retrieval())
    expect(block).toContain('[1] Result 1')
    expect(block).toContain('[3] Result 3')
    expect(block).toContain('URL: https://example2.com/page')
  })

  it('truncates each source rather than the block as a whole', () => {
    const long = retrieval({
      results: {
        ...results(1),
        results: [
          {
            title: 'Long',
            url: 'https://example.com',
            content: 'x'.repeat(5000)
          }
        ]
      }
    })
    expect(buildSourceBlock(long)).toContain('x'.repeat(1200))
    expect(buildSourceBlock(long)).not.toContain('x'.repeat(1201))
  })

  it('forbids citations outright when nothing was retrieved', () => {
    const block = buildSourceBlock(retrieval({ results: null }))
    expect(block).toMatch(/No sources were retrieved/)
    expect(block).toMatch(/Do NOT invent citations/)
    // The no-tools override still applies — an unsourced turn is still a turn
    // where the model must not narrate about searching.
    expect(block).toMatch(/REMOVED from your tools/i)
  })
})

describe('buildRetrievalToolPart', () => {
  it('produces a part the citation stack actually resolves', () => {
    // The real consumers, not a re-implementation of them: extractCitationMaps
    // reads `tool-search` parts, processCitations rewrites [N](#toolCallId)
    // into a domain link. If the synthesized shape were wrong in any way
    // (type, state, toolCallId, results), the answer text would come back
    // unchanged and the turn would ship with zero visible provenance.
    const part = buildRetrievalToolPart(retrieval())

    const message = {
      id: 'm1',
      role: 'assistant',
      parts: [
        {
          type: `tool-${part.toolName}`,
          state: 'output-available',
          toolCallId: part.toolCallId,
          input: part.input,
          output: part.output
        }
      ]
    } as unknown as UIMessage

    const maps = extractCitationMaps(message)
    expect(Object.keys(maps)).toEqual(['pipelineCall123'])
    expect(maps.pipelineCall123[2].url).toBe('https://example2.com/page')

    const rendered = processCitations(
      'Postgres shipped a fix. [2](#pipelineCall123)',
      maps
    )
    expect(rendered).toBe(
      'Postgres shipped a fix. [example2](https://example2.com/page)'
    )
  })

  it('marks the output complete so the sources panel renders it', () => {
    // components/search-section.tsx treats anything but 'complete' as still
    // searching and renders a skeleton forever.
    const part = buildRetrievalToolPart(retrieval())
    expect(part.output.state).toBe('complete')
    expect(part.output.results).toHaveLength(3)
    expect(part.input.query).toBe('postgres 18.4 release notes')
  })

  it('carries images through so the image section can render them', () => {
    const part = buildRetrievalToolPart(
      retrieval({
        results: {
          ...results(1),
          images: [{ url: 'https://cdn.example.com/a.jpg', description: 'a' }]
        }
      })
    )
    expect(part.output.images).toHaveLength(1)
  })

  it('carries the SAME sources, in the same order, as the prompt block', () => {
    // Citations resolve positionally (citation N -> results[N-1]). A part whose
    // results differ from what the prompt numbered would make every citation
    // point at the wrong page while still looking valid.
    const r = retrieval({ results: results(25) })
    const part = buildRetrievalToolPart(r)
    const block = buildSourceBlock(r)

    expect(part.output.results).toHaveLength(20)
    expect(block).toContain('[20] Result 20')
    expect(block).not.toContain('[21] Result 21')
    part.output.results.forEach((res, i) => {
      expect(block).toContain(`[${i + 1}] ${res.title}`)
    })
  })

  it('survives a failed retrieval as an empty, still-well-formed part', () => {
    const part = buildRetrievalToolPart(
      retrieval({ results: null, error: 'boom' })
    )
    expect(part.output.results).toEqual([])
    expect(part.output.number_of_results).toBe(0)
    expect(part.output.state).toBe('complete')
  })
})

afterEach(() => {
  vi.clearAllMocks()
})
