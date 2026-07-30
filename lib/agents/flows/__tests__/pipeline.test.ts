import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CLASSIFIER_TIMEOUT_MS } from '@/lib/agents/query-classifier'
import type { SearchResults } from '@/lib/types'
import type { UIMessage } from '@/lib/types/ai'
import { extractCitationMaps, processCitations } from '@/lib/utils/citation'

import {
  applyAnswerStepReserve,
  buildProvisionedToolsNote,
  buildRetrievalToolPart,
  buildSourceBlock,
  CLASSIFY_WAIT_MS,
  DEFAULT_PIPELINE_SOURCE_CHARS,
  type PipelineRetrieval,
  pipelineSourceChars,
  provisionTurnTools,
  RETRIEVAL_DEADLINE_MS,
  runPipelineRetrieval,
  shouldInjectRetrieval,
  startInformedRetrieval
} from '../pipeline'

// Hoisted so the mock factories (which vitest lifts above the imports) can
// close over these without a TDZ error.
const { runAdvancedSearch, providerSearch, expansionVariants } = vi.hoisted(
  () => ({
    runAdvancedSearch: vi.fn(),
    providerSearch: vi.fn(),
    expansionVariants: vi.fn()
  })
)

// Mocked rather than exercised: searchExpansionVariants owns real provider
// calls, caching and its own telemetry, all covered where it lives. What
// matters here is that the pipeline CALLS it and merges what it returns.
vi.mock('@/lib/tools/search', () => ({
  searchExpansionVariants: expansionVariants
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
  it('injects a time-sensitive turn', () => {
    expect(
      shouldInjectRetrieval({
        skipSearch: false,
        needsRecent: true,
        needsSources: false
      })
    ).toBe(true)
  })

  it('injects a settled-knowledge turn that still wants grounding', () => {
    // THE REGRESSION THIS FIXES. "compare Caddy, Traefik and nginx" and "what
    // is TCP" are not time-sensitive, so freshness alone declined them — and
    // the last-resort rule then handed them `search` anyway, converting a
    // saved source block into an extra model round trip.
    expect(
      shouldInjectRetrieval({
        skipSearch: false,
        needsRecent: false,
        needsSources: true
      })
    ).toBe(true)
  })

  it('declines a turn answerable from the conversation itself', () => {
    // skipSearch outranks both: the conversation already holds the answer.
    expect(
      shouldInjectRetrieval({
        skipSearch: true,
        needsRecent: true,
        needsSources: true
      })
    ).toBe(false)
  })

  it('declines a turn that needs no external facts at all', () => {
    // Pure arithmetic, an image request, small talk — nothing on the web
    // makes the answer better, so the source block is pure prompt tax.
    expect(
      shouldInjectRetrieval({
        skipSearch: false,
        needsRecent: false,
        needsSources: false
      })
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
      needsSources: true,
      imageGenAvailable: false,
      // The normal case: sources were wanted and retrieval delivered.
      sourcesRetrieved: 12,
      ...over
    })
  }

  it('gives a factual/news/code question nothing and exactly one model call', () => {
    // Retrieval already happened. There is nothing left to call, and every
    // extra permitted step is a step some model will find a way to spend.
    for (const intent of ['general', 'news', 'code', 'academic'] as const) {
      const p = provision({ intent })
      expect(p.tools).toEqual([])
      expect(p.maxSteps).toBe(2)
    }
  })

  it('gives a conversation-referential turn nothing and one model call', () => {
    const p = provision({
      skipSearch: true,
      message: 'so you mean both, yes?',
      sourcesRetrieved: null
    })
    expect(p.tools).toEqual([])
    expect(p.maxSteps).toBe(2)
  })

  it('gives a settled-knowledge turn nothing — it was grounded before the call', () => {
    // THE REGRESSION THIS FIXES. "what is TCP" used to land here with
    // `search` and a two-step loop, because the freshness gate declined its
    // sources and the escape hatch then handed it a way to go get them. With
    // needsSources the sources are simply kept, and the turn is one model
    // call with grounding — strictly faster AND strictly better sourced.
    const p = provision({
      message: 'what is the difference between TCP and UDP',
      needsRecent: false,
      needsSources: true
    })
    expect(p.tools).toEqual([])
    expect(p.maxSteps).toBe(2)
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
    expect(p.maxSteps).toBe(2)
  })

  it('hands back search only when sources were wanted and retrieval returned none', () => {
    // The genuine dead end: this turn asked for grounding, retrieval ran (and
    // retried itself once), and still came back empty. Now the model has
    // neither sources nor any way to obtain them.
    const p = provision({ sourcesRetrieved: 0 })
    expect(p.tools).toEqual(['search'])
    expect(p.maxSteps).toBe(2)
  })

  it('withholds the last resort from a turn that never asked for sources', () => {
    // sourcesRetrieved === null means the gate declined and nothing was
    // awaited. Reading that as "asked and got nothing" is exactly the
    // conflation that fired the escape hatch on every settled-knowledge turn.
    const p = provision({
      message: 'what is 17% of 4500',
      needsRecent: false,
      needsSources: false,
      sourcesRetrieved: null
    })
    expect(p.tools).toEqual(['calculate'])
  })

  it('withholds the last resort when another capability already grounds the turn', () => {
    // Retrieval came back empty, but `fetch` IS a way to get grounding, so
    // `search` would only reopen the search-again loop.
    const p = provision({
      message: 'what does https://example.com/post say about rate limits',
      sourcesRetrieved: 0
    })
    expect(p.tools).toEqual(['fetch'])
    expect(p.maxSteps).toBe(2)
  })

  it('withholds the last resort from a conversation-referential turn', () => {
    const p = provision({
      skipSearch: true,
      needsRecent: false,
      needsSources: false,
      sourcesRetrieved: null
    })
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
          for (const needsSources of [true, false]) {
            for (const imageGenAvailable of [true, false]) {
              for (const sourcesRetrieved of [null, 0, 12]) {
                const p = provisionTurnTools({
                  message,
                  intent: 'general',
                  skipSearch,
                  needsRecent,
                  needsSources,
                  imageGenAvailable,
                  sourcesRetrieved
                })
                // A FLOOR of 2, not an exact fit: activeTools only controls
                // what is advertised, so a model can emit a call for a tool it
                // was never offered and the SDK will execute it against the
                // full tool map. A ceiling of 1 turned one such stray call into
                // a zero-character answer (probe p09). The floor costs nothing
                // because the loop stops as soon as a step yields text with no
                // tool calls.
                expect(p.maxSteps).toBe(Math.max(2, p.tools.length + 1))
                expect(p.maxSteps).toBeGreaterThanOrEqual(2)
                expect(new Set(p.tools).size).toBe(p.tools.length)
              }
            }
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
    expect(p.reason).toContain('sources=injected(12)')
    expect(p.reason).toContain('needsSources=true')
    expect(
      provision({
        needsRecent: false,
        needsSources: false,
        sourcesRetrieved: null
      }).reason
    ).toContain('sources=declined')
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

// Retrieval used to fire at t=0 on raw text, which meant it could pass neither
// timeRange nor intent — they do not exist yet. A blind pairwise judge scored
// the pipeline 1W-12L-4T on the current-facts probes as a result: asked for
// figures "this year" it retrieved and faithfully cited last year's. These
// tests pin the three things the classifier now supplies, and pin that a
// classifier which never answers cannot stall the turn.
describe('startInformedRetrieval', () => {
  beforeEach(() => {
    runAdvancedSearch.mockReset()
    providerSearch.mockReset()
    expansionVariants.mockReset()
    expansionVariants.mockResolvedValue([])
    runAdvancedSearch.mockResolvedValue({ results: results(5) })
  })

  afterEach(() => {
    delete process.env.SEARCH_API
  })

  it('retrieves on the classifier rewrite, not the raw words', async () => {
    // "and Germany?" retrieves for Germany rather than for two words.
    await startInformedRetrieval({
      rawQuery: 'and Germany?',
      classification: Promise.resolve({
        standaloneQuery: 'What is the capital of Germany?',
        needsRecent: false,
        intent: 'general' as const
      }),
      chatId: 'c1'
    })
    expect(runAdvancedSearch.mock.calls[0][0]).toMatchObject({
      query: 'What is the capital of Germany?'
    })
  })

  it('narrows to the last month when the turn needs current facts', async () => {
    // The SAME mapping the loop's search tool uses, so the two cannot drift.
    await startInformedRetrieval({
      rawQuery: 'global EV sales this year',
      classification: Promise.resolve({
        standaloneQuery: 'global EV sales this year',
        needsRecent: true,
        intent: 'news' as const
      })
    })
    expect(runAdvancedSearch.mock.calls[0][0]).toMatchObject({
      timeRange: 'month',
      intent: 'news'
    })
  })

  it('leaves the window open for settled knowledge', async () => {
    await startInformedRetrieval({
      rawQuery: 'what is TCP',
      classification: Promise.resolve({
        standaloneQuery: 'what is TCP',
        needsRecent: false
      })
    })
    expect(runAdvancedSearch.mock.calls[0][0].timeRange).toBeUndefined()
  })

  it('falls back to raw text when the classifier rejects', async () => {
    const r = await startInformedRetrieval({
      rawQuery: 'who won the election',
      classification: Promise.reject(new Error('classifier down'))
    })
    expect(runAdvancedSearch.mock.calls[0][0]).toMatchObject({
      query: 'who won the election'
    })
    expect(r.results?.results).toHaveLength(5)
  })

  it('waits longer than the classifier can possibly take', async () => {
    // THE BUG THIS PINS. These were two independently chosen numbers: the
    // pipeline gave up at 5s on a call already bounded at CLASSIFIER_TIMEOUT_MS
    // (10s) that also falls back rather than rejecting. So the deadline could
    // not prevent a hang — there cannot be one past 10s — and could only fire
    // in the 5-10s window where the classifier WAS about to answer, discarding
    // that turn's query rewrite and freshness window. It tripped on 1 turn in 8
    // (classify_ms median 1525ms, spike 9069ms).
    //
    // Asserted as an inequality rather than a literal so raising the
    // classifier's timeout cannot silently reintroduce it.
    expect(CLASSIFY_WAIT_MS).toBeGreaterThan(CLASSIFIER_TIMEOUT_MS)
  })

  it('falls back to raw text rather than waiting forever', async () => {
    // A hung classifier must delay UNDERSTANDING, never the turn. Without the
    // deadline this change would reintroduce the serial preamble the whole
    // architecture exists to remove.
    vi.useFakeTimers()
    try {
      const p = startInformedRetrieval({
        rawQuery: 'raw words',
        classification: new Promise(() => {}) // never settles
      })
      await vi.advanceTimersByTimeAsync(CLASSIFY_WAIT_MS + 10)
      await p
      expect(runAdvancedSearch.mock.calls[0][0]).toMatchObject({
        query: 'raw words'
      })
      expect(runAdvancedSearch.mock.calls[0][0].timeRange).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  // THE BREADTH DEFICIT. This architecture retrieved on ONE phrasing while the
  // loop's first search retrieves on up to four. A blind judge scored it
  // 0W-13L-3T on the current-facts probes, and 11 of its 20 losses were turns
  // where it had MORE sources and MORE citations — so what it lacked was
  // breadth of DISCOVERY, not volume.
  describe('expansion variants', () => {
    it('searches the classifier expansions alongside the main query', async () => {
      await startInformedRetrieval({
        rawQuery: 'ev sales',
        classification: Promise.resolve({
          standaloneQuery: 'global EV sales 2026',
          needsRecent: true,
          expandedQueries: ['worldwide EV registrations 2026', 'BEV volume H1']
        }),
        chatId: 'c1'
      })
      expect(expansionVariants).toHaveBeenCalledWith(
        ['worldwide EV registrations 2026', 'BEV volume H1'],
        // The SAME freshness window as the main query — variants that ignored
        // it would widen discovery straight back into stale pages.
        'month',
        'c1'
      )
    })

    it('does not call out at all when there are no expansions', async () => {
      await startInformedRetrieval({
        rawQuery: 'what is TCP',
        classification: Promise.resolve({
          standaloneQuery: 'what is TCP',
          expandedQueries: []
        })
      })
      expect(expansionVariants).not.toHaveBeenCalled()
    })

    it('appends only URLs the main search did not already find', async () => {
      runAdvancedSearch.mockResolvedValue({ results: results(2) })
      expansionVariants.mockResolvedValue([
        // Duplicate of main result 1 — must not appear twice.
        { title: 'dupe', url: 'https://example1.com/page', content: 'x' },
        { title: 'fresh', url: 'https://brand-new.com/page', content: 'y' }
      ])
      const r = await startInformedRetrieval({
        rawQuery: 'q',
        classification: Promise.resolve({
          standaloneQuery: 'q',
          expandedQueries: ['v1']
        })
      })
      const urls = (r.results?.results ?? []).map(x => x.url)
      expect(urls).toEqual([
        'https://example1.com/page',
        'https://example2.com/page',
        'https://brand-new.com/page'
      ])
      expect(r.results?.number_of_results).toBe(3)
    })

    it('keeps deep-crawled results in the low citation numbers', async () => {
      // Order is not cosmetic: citations resolve POSITIONALLY, so the
      // reranked, deep-crawled pages must hold the numbers the model reaches
      // for most, with snippet-depth discoveries filling in behind them.
      runAdvancedSearch.mockResolvedValue({ results: results(3) })
      expansionVariants.mockResolvedValue([
        { title: 'snippet', url: 'https://later.com/p', content: 'z' }
      ])
      const r = await startInformedRetrieval({
        rawQuery: 'q',
        classification: Promise.resolve({
          standaloneQuery: 'q',
          expandedQueries: ['v1']
        })
      })
      expect(r.results?.results?.[0].url).toBe('https://example1.com/page')
      expect(r.results?.results?.at(-1)?.url).toBe('https://later.com/p')
    })

    it('still returns the main results when every variant fails', async () => {
      // Widening is a bonus; losing it must never cost the turn its sources.
      expansionVariants.mockRejectedValue(new Error('all variants down'))
      const r = await startInformedRetrieval({
        rawQuery: 'q',
        classification: Promise.resolve({
          standaloneQuery: 'q',
          expandedQueries: ['v1']
        })
      })
      expect(r.results?.results).toHaveLength(5)
    })
  })

  it('ignores a blank rewrite instead of retrieving nothing', async () => {
    // The classifier is told never to return an empty standaloneQuery; if it
    // does anyway, a blank query would silently retrieve zero sources.
    await startInformedRetrieval({
      rawQuery: 'real question here',
      classification: Promise.resolve({ standaloneQuery: '   ' })
    })
    expect(runAdvancedSearch.mock.calls[0][0]).toMatchObject({
      query: 'real question here'
    })
  })
})

// Under the loop a stalled search costs one step and the model carries on.
// Here the answer DEPENDS on the single retrieval, so a stall took the whole
// turn down: probe p08 returned `wall 300.0s, steps=1, tool_calls=0,
// sources=0` and a zero-character answer — it sat in retrieval until
// route.ts's GENERATION_TIMEOUT_MS aborted everything, and that abort persists
// nothing. Five minutes of waiting for a blank page.
describe('runPipelineRetrieval — deadline', () => {
  beforeEach(() => {
    runAdvancedSearch.mockReset()
    providerSearch.mockReset()
    expansionVariants.mockReset()
    expansionVariants.mockResolvedValue([])
  })

  it('gives up on a stalled retrieval and reports it', async () => {
    vi.useFakeTimers()
    try {
      runAdvancedSearch.mockReturnValue(new Promise(() => {})) // never settles
      const p = runPipelineRetrieval('q')
      await vi.advanceTimersByTimeAsync(RETRIEVAL_DEADLINE_MS + 10)
      const r = await p
      // Degrades rather than throws: buildSourceBlock renders an honest "no
      // sources were retrieved" prompt for exactly this shape, so the turn
      // answers unsourced and says so.
      expect(r.results).toBeNull()
      expect(r.error).toMatch(/deadline/i)
      expect(r.toolCallId).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('salvages resolved expansion results rather than answering unsourced', async () => {
    // The chain awaits `variants` only AFTER the main search settles, so when
    // the MAIN search is what stalls the variant results sit resolved and
    // unread. Measured on chat ovd3r52d: three turns logged expansion
    // `returned: 24-30` within ~1.7s and then "retrieval EXCEEDED 90000ms —
    // answering unsourced" with pipeline_retrieved: 0. Snippet-depth results
    // are a downgrade from a crawled page and are not close to a downgrade
    // from nothing, which cannot be cited at all.
    vi.useFakeTimers()
    try {
      runAdvancedSearch.mockReturnValue(new Promise(() => {})) // never settles
      expansionVariants.mockResolvedValue([
        { url: 'https://a.example', title: 'A', content: 'a' },
        { url: 'https://b.example', title: 'B', content: 'b' }
      ])

      const p = runPipelineRetrieval('q', { expandedQueries: ['q alt'] })
      await vi.advanceTimersByTimeAsync(RETRIEVAL_DEADLINE_MS + 10)
      const r = await p

      expect(r.results?.results).toHaveLength(2)
      expect(r.results?.results?.[0]?.url).toBe('https://a.example')
      // Still reported as a deadline miss — salvaging is a degradation, and
      // telemetry that hid it would make the stall invisible.
      expect(r.error).toMatch(/deadline/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still answers unsourced when nothing at all resolved in time', async () => {
    vi.useFakeTimers()
    try {
      runAdvancedSearch.mockReturnValue(new Promise(() => {}))
      expansionVariants.mockReturnValue(new Promise(() => {}))
      const p = runPipelineRetrieval('q', { expandedQueries: ['q alt'] })
      await vi.advanceTimersByTimeAsync(RETRIEVAL_DEADLINE_MS + 10)
      expect((await p).results).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sits above every real retrieval and below every observed stall', async () => {
    // Healthy retrieval on this stack runs 10-40s with a worst legitimate
    // completion of 71s; a crawler-saturation stall runs 110-140s. Asserted as
    // a range so a later tweak has to confront that distribution.
    expect(RETRIEVAL_DEADLINE_MS).toBeGreaterThan(71_000)
    expect(RETRIEVAL_DEADLINE_MS).toBeLessThan(110_000)
  })

  it('leaves the model most of the turn budget to write in', async () => {
    // route.ts aborts the whole turn at GENERATION_TIMEOUT_MS (300s). A
    // deadline near that ceiling would be no deadline at all.
    expect(RETRIEVAL_DEADLINE_MS).toBeLessThan(300_000 / 2)
  })
})

describe('runPipelineRetrieval', () => {
  beforeEach(() => {
    runAdvancedSearch.mockReset()
    providerSearch.mockReset()
    expansionVariants.mockReset()
    expansionVariants.mockResolvedValue([])
  })

  afterEach(() => {
    delete process.env.SEARCH_API
  })

  it('routes through the advanced pipeline, not a bare provider search', async () => {
    runAdvancedSearch.mockResolvedValue({ results: results(5) })

    const r = await runPipelineRetrieval('who won the election', {
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

    const r = await runPipelineRetrieval('anything')

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

    const r = await runPipelineRetrieval('current postgres version')

    expect(runAdvancedSearch).toHaveBeenCalledTimes(2)
    expect(r.results?.results).toHaveLength(4)
  })

  it('does not retry when the first pass returns results', async () => {
    runAdvancedSearch.mockResolvedValue({ results: results(2) })
    await runPipelineRetrieval('anything')
    expect(runAdvancedSearch).toHaveBeenCalledTimes(1)
  })

  it('never rejects when the advanced path throws', async () => {
    // A failed retrieval degrades to an unsourced answer. It must not take the
    // turn down: this architecture has no second chance by construction.
    runAdvancedSearch.mockRejectedValue(new Error('crawl4ai is down'))

    const r = await runPipelineRetrieval('anything')

    expect(r.results).toBeNull()
    expect(r.error).toContain('crawl4ai is down')
    expect(r.toolCallId).toBeTruthy()
  })

  it('short-circuits an empty query without searching', async () => {
    const r = await runPipelineRetrieval('   ')
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
    // A single source is in the DEEP tier, so it gets the deep budget — this
    // used to assert a flat 1200 for every source, which was the information
    // loss the graduated budget replaced.
    const block = buildSourceBlock(long)
    expect(block).toContain('x'.repeat(DEFAULT_PIPELINE_SOURCE_CHARS))
    expect(block).not.toContain('x'.repeat(DEFAULT_PIPELINE_SOURCE_CHARS + 1))
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

describe('provisionTurnTools — memory', () => {
  const base = {
    intent: 'general' as const,
    skipSearch: false,
    needsRecent: true,
    needsSources: true,
    imageGenAvailable: false,
    sourcesRetrieved: 12
  }

  it('provisions remember for an explicit memory request', () => {
    // Without this the request silently falls to the post-turn extractor and
    // the user is never told whether it was saved.
    const r = provisionTurnTools({
      ...base,
      message: 'Remember that I run Postgres 18 in production.'
    })
    expect(r.tools).toContain('remember')
    expect(r.maxSteps).toBe(r.tools.length + 1)
  })

  it('does not provision remember for an ordinary question', () => {
    const r = provisionTurnTools({
      ...base,
      message: 'What changed in PostgreSQL 18?'
    })
    expect(r.tools).not.toContain('remember')
  })

  it('never provisions recall — it is injected, not called', () => {
    // getRecallInjection runs in the streaming layer and reaches the model as
    // recallBlock before the first token, so a tool step would buy nothing.
    for (const message of [
      'What did we discuss about Postgres last week?',
      'Remember that I prefer Caddy.'
    ]) {
      expect(provisionTurnTools({ ...base, message }).tools).not.toContain(
        'recall' as never
      )
    }
  })
})

// The budget guarantee. Measured shape of every 0-character answer across two
// probe runs: steps=2, tools=2 — the model spent its whole budget on tool
// calls and the turn ended before a word was written. Every answer that had
// prose made at most one tool call.
describe('applyAnswerStepReserve', () => {
  const SYS = 'BASE PROMPT WITH SOURCES'

  it('leaves every step but the last untouched', () => {
    // maxSteps=3 (two tools + the answer): steps 0 and 1 may call tools.
    for (const stepNumber of [0, 1]) {
      expect(
        applyAnswerStepReserve(
          {},
          { stepNumber, maxSteps: 3, systemPrompt: SYS }
        )
      ).toEqual({})
    }
  })

  it('empties activeTools on the last permitted step', () => {
    // stepNumber is 0-indexed, so the last permitted step is maxSteps - 1.
    // This is the step the arithmetic probe spent on a second `calculate`.
    for (const args of [
      { stepNumber: 2, maxSteps: 3, systemPrompt: SYS },
      { stepNumber: 1, maxSteps: 2, systemPrompt: SYS }
    ]) {
      expect(
        applyAnswerStepReserve<{ activeTools?: string[] }>({}, args).activeTools
      ).toEqual([])
    }
  })

  it('reserves a prose step even on a turn provisioned with no tools', () => {
    // THE p09 REGRESSION. A sourced turn gets tools=[] and, before the floor,
    // maxSteps=1 — so when kimi-k2.6 emitted an unoffered `search` call (which
    // the SDK executes, because activeTools only governs advertising) the loop
    // stopped with no step left and returned zero characters. With the floor of
    // 2 the reserve fires on step 1 and prose is the only possible output.
    const out = applyAnswerStepReserve<{
      activeTools?: string[]
      system?: string
    }>({}, { stepNumber: 1, maxSteps: 2, systemPrompt: 'SOURCES' })
    expect(out.activeTools).toEqual([])
    expect(out.system).toContain('FINAL STEP')
  })

  it('tells the model to answer, rather than only taking the tools away', () => {
    // Removing the tools silently is not enough: when `calculate` rejected its
    // expression the model spent the reserved step reasoning "let me try a
    // different format" and emitted NO prose, because nothing told it the turn
    // was over. The note is carried on the same step as the empty tool list.
    const out = applyAnswerStepReserve<{ system?: string }>(
      {},
      { stepNumber: 1, maxSteps: 2, systemPrompt: SYS }
    )
    expect(out.system).toContain(SYS)
    expect(out.system).toContain('FINAL STEP')
    expect(out.system).toMatch(/do NOT propose retrying/i)
  })

  it('keeps the whole prompt, because `system` replaces rather than appends', () => {
    // Sending only the note would drop the source block and every citation
    // rule with it — the answer would lose its grounding on the last step.
    const out = applyAnswerStepReserve<{ system?: string }>(
      {},
      { stepNumber: 1, maxSteps: 2, systemPrompt: SYS }
    )
    expect(out.system?.startsWith(SYS)).toBe(true)
  })

  it('overrides a variant that would hand tools back on the final step', () => {
    // Applied last, so a variant's per-step tool preference cannot spend the
    // step reserved for prose. A variant that replaced the prompt keeps its
    // replacement — the note is appended to whichever prompt is in force.
    const out = applyAnswerStepReserve(
      { system: 'variant prompt', activeTools: ['search'] },
      { stepNumber: 1, maxSteps: 2, systemPrompt: SYS }
    )
    expect(out.activeTools).toEqual([])
    expect(out.system?.startsWith('variant prompt')).toBe(true)
    expect(out.system).not.toContain(SYS)
    expect(out.system).toContain('FINAL STEP')
  })

  it('is a no-op when no tools were provisioned', () => {
    // maxSteps=1 is the one-call turn: the single step IS the answer, and
    // there is nothing to reserve it from.
    expect(
      applyAnswerStepReserve(
        {},
        { stepNumber: 0, maxSteps: 1, systemPrompt: SYS }
      )
    ).toEqual({})
  })

  it('leaves at least one tool-free step for every provisioned shape', () => {
    // The invariant, not an example: with maxSteps = tools.length + 1, a model
    // can call at most tools.length tools no matter how it distributes them,
    // so a step always remains in which prose is the only thing it can emit.
    for (let toolCount = 1; toolCount <= 5; toolCount++) {
      const maxSteps = toolCount + 1
      const toolFree = Array.from({ length: maxSteps }, (_, stepNumber) =>
        applyAnswerStepReserve<{ activeTools?: string[] }>(
          {},
          { stepNumber, maxSteps, systemPrompt: SYS }
        )
      ).filter(o => o.activeTools?.length === 0)
      expect(toolFree.length).toBeGreaterThanOrEqual(1)
    }
  })
})

// The loop's search tool does not truncate at all; this architecture caps every
// source, so 20 sources is at most ~24k characters of evidence at the default
// no matter how substantial the pages were. That is information the loop keeps
// and this loses, and it is the leading unfalsified explanation for the
// pipeline losing a blind judge on turns where it had MORE sources and MORE
// citations. The knob exists to measure the speed-for-evidence exchange rate
// rather than assume it.
describe('pipelineSourceChars', () => {
  afterEach(() => {
    delete process.env.PIPELINE_SOURCE_CHARS
  })

  it('defaults to the in-code budget when unset', () => {
    expect(pipelineSourceChars()).toBe(DEFAULT_PIPELINE_SOURCE_CHARS)
  })

  it('truncates nothing the crawler actually produces', () => {
    // Measured over 81 crawled sources: median 2,558 chars, max 3,499. So the
    // budget is a bound against a pathological page, not a content policy —
    // every real source reaches the model whole, which is what the loop does
    // and what this architecture was uniquely losing.
    const realistic = 'y'.repeat(3499)
    const r: PipelineRetrieval = {
      query: 'q',
      ms: 1,
      toolCallId: 'tc',
      results: {
        query: 'q',
        images: [],
        number_of_results: 20,
        results: Array.from({ length: 20 }, (_, i) => ({
          title: `T${i + 1}`,
          url: `https://e${i + 1}.com/p`,
          content: realistic
        }))
      }
    }
    const block = buildSourceBlock(r)
    // Every source, not just the first few, survives intact.
    for (const n of [1, 8, 12, 20]) {
      const start = block.indexOf(`[${n}] T${n}`)
      const next = block.indexOf(`[${n + 1}] T${n + 1}`)
      const section = block.slice(start, next === -1 ? undefined : next)
      expect(section.length).toBeGreaterThan(3499)
    }
  })

  it('carries more total evidence than the flat 1200-char budget it replaced', () => {
    // The regression guard for the change itself: 1200 flat was ~300 tokens a
    // source, barely more than the engine snippet the deep crawl existed to
    // replace, and ~90% of what was crawled never reached the model.
    const long = 'z'.repeat(9000)
    const r: PipelineRetrieval = {
      query: 'q',
      ms: 1,
      toolCallId: 'tc',
      results: {
        query: 'q',
        images: [],
        number_of_results: 20,
        results: Array.from({ length: 20 }, (_, i) => ({
          title: `T${i + 1}`,
          url: `https://e${i + 1}.com/p`,
          content: long
        }))
      }
    }
    const now = buildSourceBlock(r).length
    const flatOld = 20 * 1200
    expect(now).toBeGreaterThan(flatOld * 1.5)
  })

  it('honours a valid override', () => {
    process.env.PIPELINE_SOURCE_CHARS = '6000'
    expect(pipelineSourceChars()).toBe(6000)
  })

  it('falls back to the default on junk rather than to unbounded', () => {
    // A typo must not silently hand the model a 500k-token prompt.
    for (const bad of ['', 'lots', '0', '-500', 'NaN']) {
      process.env.PIPELINE_SOURCE_CHARS = bad
      expect(pipelineSourceChars()).toBe(DEFAULT_PIPELINE_SOURCE_CHARS)
    }
  })

  it('actually changes how much of a source reaches the prompt', () => {
    const long = 'x'.repeat(5000)
    const withLongContent: PipelineRetrieval = {
      query: 'q',
      ms: 1,
      toolCallId: 'tc1',
      results: {
        query: 'q',
        images: [],
        number_of_results: 1,
        results: [{ title: 'T', url: 'https://e.com/p', content: long }]
      }
    }
    process.env.PIPELINE_SOURCE_CHARS = '1200'
    const short = buildSourceBlock(withLongContent)
    process.env.PIPELINE_SOURCE_CHARS = '5000'
    const full = buildSourceBlock(withLongContent)
    expect(full.length).toBeGreaterThan(short.length + 3000)
  })
})
