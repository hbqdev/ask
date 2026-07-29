import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SearchResults } from '@/lib/types'
import type { UIMessage } from '@/lib/types/ai'
import { extractCitationMaps, processCitations } from '@/lib/utils/citation'

import {
  buildProvisionedToolsNote,
  buildRetrievalToolPart,
  buildSourceBlock,
  type PipelineRetrieval,
  provisionTurnTools,
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

// The system decides which tools a turn gets; the model uses what it is given.
// These tests pin the table that decision is specified by — and, above all,
// that the step cap and the tool list are never stated independently of each
// other, since a cap that disagrees with the list is the bug class the single
// function exists to design out.
describe('provisionTurnTools', () => {
  // A searched, time-sensitive turn: the classifier's normal "go look this up"
  // verdict, so retrieval was injected before the model was called.
  function provision(
    over: Partial<Parameters<typeof provisionTurnTools>[0]> = {}
  ) {
    return provisionTurnTools({
      message: 'what changed in the latest postgres release',
      intent: 'general',
      skipSearch: false,
      needsRecent: true,
      imageGenAvailable: false,
      ...over
    })
  }

  it('gives a factual/news/code question nothing and exactly one model call', () => {
    // Retrieval already happened. There is nothing left to call, and every
    // extra permitted step is a step some model will find a way to spend.
    for (const intent of ['general', 'news', 'code', 'academic'] as const) {
      const p = provision({ intent })
      expect(p.tools).toEqual([])
      expect(p.maxSteps).toBe(1)
    }
  })

  it('gives a conversation-referential turn nothing and one model call', () => {
    const p = provision({ skipSearch: true, message: 'so you mean both, yes?' })
    expect(p.tools).toEqual([])
    expect(p.maxSteps).toBe(1)
  })

  it('gives a message containing a URL fetch, and two steps to use it', () => {
    const p = provision({
      message: 'summarise https://www.postgresql.org/docs/release/18.4/'
    })
    expect(p.tools).toEqual(['fetch'])
    expect(p.maxSteps).toBe(2)
  })

  it('gives an arithmetic turn calculate', () => {
    expect(provision({ message: "what's 17% of 4230" }).tools).toEqual([
      'calculate'
    ])
    expect(provision({ message: 'compute (3 + 5) * 12 / 4' }).tools).toEqual([
      'calculate'
    ])
    expect(provision({ message: 'convert 100 USD to EUR' }).tools).toEqual([
      'calculate'
    ])
  })

  it('gives a weather question get_weather', () => {
    const p = provision({ message: "what's the weather in Tokyo tomorrow" })
    expect(p.tools).toEqual(['get_weather'])
    expect(p.maxSteps).toBe(2)
  })

  it('gives an image request generateImage even though the classifier skipped search', () => {
    // The classifier is instructed to set skipSearch=true for a pure "draw me
    // X" request. A skipSearch-implies-no-tools rule would strip the one tool
    // the turn exists to use.
    const p = provision({
      message: 'draw me a picture of the Sydney Opera House',
      skipSearch: true,
      needsRecent: false,
      imageGenAvailable: true
    })
    expect(p.tools).toEqual(['generateImage'])
    expect(p.maxSteps).toBe(2)
  })

  it('never provisions generateImage when the tool is not registered', () => {
    // Ephemeral turns and unconfigured deployments have no generateImage in the
    // tool map; advertising it would name a tool the SDK cannot call.
    const p = provision({
      message: 'draw me a picture of the Sydney Opera House',
      skipSearch: true,
      needsRecent: false,
      imageGenAvailable: false
    })
    expect(p.tools).toEqual([])
    expect(p.maxSteps).toBe(1)
  })

  it('hands back search when the turn has no sources and nothing else', () => {
    // "What is TCP" — not in the conversation (so not skippable), not
    // time-sensitive (so shouldInjectRetrieval declined). Without this the
    // model has neither sources nor any way to obtain them.
    const p = provision({
      message: 'what is the difference between TCP and UDP',
      needsRecent: false
    })
    expect(p.tools).toEqual(['search'])
    expect(p.maxSteps).toBe(2)
  })

  it('withholds the escape hatch when another capability already grounds the turn', () => {
    // A URL turn bypasses the classifier (needsRecent=false), so no sources are
    // injected — but `fetch` IS a way to get grounding, so `search` would only
    // reopen the search-again loop.
    const p = provision({
      message: 'what does https://example.com/post say about rate limits',
      needsRecent: false
    })
    expect(p.tools).toEqual(['fetch'])
    expect(p.maxSteps).toBe(2)
  })

  it('withholds the escape hatch from a conversation-referential turn', () => {
    const p = provision({ skipSearch: true, needsRecent: false })
    expect(p.tools).toEqual([])
  })

  it('never provisions todoWrite, remember, recall or askQuestion', () => {
    // todoWrite reopens the multi-step planning loop this architecture removes;
    // memory is already resolved into the prompt before the model is called.
    const shapes = [
      provision(),
      provision({ skipSearch: true }),
      provision({ needsRecent: false }),
      provision({ message: 'draw a logo', imageGenAvailable: true }),
      provision({ message: 'weather in Oslo and 12 * 7' })
    ]
    for (const p of shapes) {
      for (const banned of ['todoWrite', 'remember', 'recall', 'askQuestion']) {
        expect(p.tools).not.toContain(banned)
      }
    }
  })

  it('keeps the step cap and the tool list in agreement on every shape', () => {
    // The invariant, not an example of it: one step per provisioned capability
    // plus the step that writes the answer. A cap below that strands a tool
    // result with no prose; a cap above it buys steps nothing was provisioned
    // for.
    for (const message of [
      'what is TCP',
      'summarise https://example.com and 4 * 9',
      "what's the weather in Oslo",
      'draw me a picture of a cat',
      'so you mean both?'
    ]) {
      for (const skipSearch of [true, false]) {
        for (const needsRecent of [true, false]) {
          for (const imageGenAvailable of [true, false]) {
            const p = provisionTurnTools({
              message,
              intent: 'general',
              skipSearch,
              needsRecent,
              imageGenAvailable
            })
            expect(p.maxSteps).toBe(p.tools.length + 1)
            expect(new Set(p.tools).size).toBe(p.tools.length)
          }
        }
      }
    }
  })

  it('does not read ordinary technical prose as a capability cue', () => {
    // False positives cost a permitted step the turn did not need, so the cues
    // are verb-and-object rather than bare keywords.
    const code = provision({
      message:
        'how does React render a component, and can I convert this class to hooks',
      intent: 'code',
      imageGenAvailable: true
    })
    expect(code.tools).toEqual([])
    // Version strings and date ranges are not sums.
    expect(
      provision({ message: 'what is new in Postgres 18.4' }).tools
    ).toEqual([])
    expect(
      provision({ message: 'summarise the 2024-2025 season' }).tools
    ).toEqual([])
  })

  it('records the signals that produced the decision for the audit log', () => {
    // Intent is reported, never acted on: SEARCH_INTENTS is a source taxonomy
    // (which engines to add), and none of its values implies a tool.
    const p = provision({ intent: 'news' })
    expect(p.reason).toContain('intent=news')
    expect(p.reason).toContain('sources=injected')
    expect(provision({ needsRecent: false }).reason).toContain('sources=none')
  })
})

describe('buildProvisionedToolsNote', () => {
  it('cancels the loop prompts offer of tools this turn does not have', () => {
    // DIRECT_ANSWER_PROMPT offers search/fetch/calculate as escape hatches and
    // the search-mode prompts demand `search` first. With an empty provisioning
    // both order the model to do the impossible.
    const note = buildProvisionedToolsNote([])
    expect(note).toMatch(/NO tools this turn/i)
    expect(note).toMatch(/do NOT apply to this turn/i)
    expect(note).toMatch(/`search`/)
  })

  it('names the tool a provisioned turn actually has', () => {
    const note = buildProvisionedToolsNote(['fetch'])
    expect(note).toContain('`fetch`')
    expect(note).not.toMatch(/NO tools this turn/i)
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
