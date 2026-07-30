import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createResearcher,
  getResearcherTools,
  getSourcesPromptAddendum,
  resolveTurnMode,
  wrapSearchToolForSources
} from '../researcher'

// Keep createResearcher hermetic: the memory injection is the only step that
// would otherwise reach the database. getModel() below is left real — for a
// non-Ollama model it just constructs a lazy LanguageModel with no network.
vi.mock('@/lib/memory/inject', () => ({
  getMemoryInjection: vi.fn(async () => '')
}))

// A minimal stand-in for the real search tool: captures the params it was
// called with and yields a single 'complete' chunk, mirroring the shape
// createSearchTool()'s execute() produces.
function makeFakeSearchTool() {
  const calls: any[] = []
  const tool = {
    description: 'fake search tool',
    inputSchema: {} as any,
    toModelOutput: undefined,
    async *execute(params: any) {
      calls.push(params)
      yield { state: 'complete' as const, results: [], images: [], query: '' }
    }
  }
  return { tool: tool as any, calls }
}

async function runTool(tool: any, params: any) {
  const iterable = tool.execute(params, {})
  const chunks: any[] = []
  for await (const chunk of iterable) {
    chunks.push(chunk)
  }
  return chunks
}

describe('wrapSearchToolForSources', () => {
  it('returns the original tool unchanged for web-only (default)', () => {
    const { tool } = makeFakeSearchTool()
    const wrapped = wrapSearchToolForSources(tool, ['web'])
    expect(wrapped).toBe(tool)
  })

  it('returns the original tool unchanged when web is present alongside academic/social', () => {
    const { tool } = makeFakeSearchTool()
    expect(wrapSearchToolForSources(tool, ['web', 'academic'])).toBe(tool)
    expect(wrapSearchToolForSources(tool, ['web', 'social'])).toBe(tool)
    expect(wrapSearchToolForSources(tool, ['web', 'academic', 'social'])).toBe(
      tool
    )
  })

  it('returns the original tool unchanged for academic+social with web off (advisory, not enforced)', () => {
    const { tool } = makeFakeSearchTool()
    const wrapped = wrapSearchToolForSources(tool, ['academic', 'social'])
    expect(wrapped).toBe(tool)
  })

  it('forces search_mode: "academic" on every call for academic-only (web off)', async () => {
    const { tool, calls } = makeFakeSearchTool()
    const wrapped = wrapSearchToolForSources(tool, ['academic'])
    expect(wrapped).not.toBe(tool)

    await runTool(wrapped, { query: 'test', search_mode: 'web' })
    expect(calls).toHaveLength(1)
    expect(calls[0].search_mode).toBe('academic')
  })

  it('forces search_mode: "social" on every call for social-only (web off)', async () => {
    const { tool, calls } = makeFakeSearchTool()
    const wrapped = wrapSearchToolForSources(tool, ['social'])
    expect(wrapped).not.toBe(tool)

    await runTool(wrapped, { query: 'test', search_mode: 'web' })
    expect(calls).toHaveLength(1)
    expect(calls[0].search_mode).toBe('social')
  })

  it('overrides whatever search_mode the model tried to pass for academic-only', async () => {
    const { tool, calls } = makeFakeSearchTool()
    const wrapped = wrapSearchToolForSources(tool, ['academic'])

    await runTool(wrapped, { query: 'test', search_mode: 'social' })
    expect(calls[0].search_mode).toBe('academic')
  })

  it('passes through other params unchanged for academic-only', async () => {
    const { tool, calls } = makeFakeSearchTool()
    const wrapped = wrapSearchToolForSources(tool, ['academic'])

    await runTool(wrapped, {
      query: 'quantum computing',
      max_results: 15,
      content_types: ['web']
    })
    expect(calls[0].query).toBe('quantum computing')
    expect(calls[0].max_results).toBe(15)
    expect(calls[0].content_types).toEqual(['web'])
  })

  it('yields through the underlying tool chunks unchanged', async () => {
    const { tool } = makeFakeSearchTool()
    const wrapped = wrapSearchToolForSources(tool, ['social'])

    const chunks = await runTool(wrapped, { query: 'test' })
    expect(chunks).toEqual([
      { state: 'complete', results: [], images: [], query: '' }
    ])
  })
})

describe('getSourcesPromptAddendum', () => {
  it('returns empty string for web-only', () => {
    expect(getSourcesPromptAddendum(['web'])).toBe('')
  })

  it('mentions forced academic routing for academic-only', () => {
    const text = getSourcesPromptAddendum(['academic'])
    expect(text).toMatch(/academic/i)
    expect(text).toMatch(/automatically routed/i)
  })

  it('mentions forced social routing for social-only', () => {
    const text = getSourcesPromptAddendum(['social'])
    expect(text).toMatch(/social/i)
    expect(text).toMatch(/automatically routed/i)
    // Must not reference the old broken mechanism.
    expect(text).not.toMatch(/include_domains/i)
    expect(text).not.toMatch(/reddit\.com/i)
  })

  it('describes a per-query choice for academic+social with web off', () => {
    const text = getSourcesPromptAddendum(['academic', 'social'])
    expect(text).toMatch(/academic/i)
    expect(text).toMatch(/social/i)
    expect(text).toMatch(/no web/i)
  })

  it('describes a per-query choice for web+academic+social', () => {
    const text = getSourcesPromptAddendum(['web', 'academic', 'social'])
    expect(text).toMatch(/multi-source/i)
  })

  it('gives advisory (non-forced) guidance for web+academic', () => {
    const text = getSourcesPromptAddendum(['web', 'academic'])
    expect(text).toMatch(/academic sources enabled/i)
    expect(text).not.toMatch(/automatically routed/i)
  })

  it('gives advisory (non-forced) guidance for web+social', () => {
    const text = getSourcesPromptAddendum(['web', 'social'])
    expect(text).toMatch(/social sources enabled/i)
    expect(text).not.toMatch(/automatically routed/i)
  })

  it('includes zero-results retry guidance for exclusive academic-only mode', () => {
    // Forcing search_mode without a Web fallback means a sparse/empty
    // result set has nowhere to fall back to — the model needs explicit
    // guidance not to spiral into open-ended self-doubt about it.
    const text = getSourcesPromptAddendum(['academic'])
    expect(text).toMatch(/zero or very few results/i)
    expect(text).toMatch(/retry once/i)
  })

  it('includes zero-results retry guidance for exclusive social-only mode', () => {
    const text = getSourcesPromptAddendum(['social'])
    expect(text).toMatch(/zero or very few results/i)
    expect(text).toMatch(/retry once/i)
  })

  it('does not include zero-results retry guidance for non-exclusive combinations (web fallback exists)', () => {
    expect(getSourcesPromptAddendum(['web', 'academic'])).not.toMatch(
      /zero or very few results/i
    )
    expect(getSourcesPromptAddendum(['academic', 'social'])).not.toMatch(
      /zero or very few results/i
    )
  })
})

describe('createResearcher — generateImage tool registration', () => {
  const original = process.env.REPLICATE_API_TOKEN

  afterEach(() => {
    if (original === undefined) delete process.env.REPLICATE_API_TOKEN
    else process.env.REPLICATE_API_TOKEN = original
  })

  it('registers the generateImage tool when REPLICATE_API_TOKEN is configured', async () => {
    process.env.REPLICATE_API_TOKEN = 'test-token'
    const agent = await createResearcher({
      model: 'openai:gpt-4o',
      userId: 'user-1'
    })
    expect(getResearcherTools(agent)).toHaveProperty('generateImage')
  })

  it('omits the generateImage tool when REPLICATE_API_TOKEN is unset', async () => {
    delete process.env.REPLICATE_API_TOKEN
    const agent = await createResearcher({
      model: 'openai:gpt-4o',
      userId: 'user-1'
    })
    expect(getResearcherTools(agent)).not.toHaveProperty('generateImage')
  })

  // Ephemeral/incognito turns run createResearcher with no userId (see
  // create-ephemeral-chat-stream-response.ts). Image generation persists into
  // the requesting user's upload store, so without a userId there is nowhere
  // to file the result — and createGenerateImageTool requires a string userId.
  // The tool is therefore gated on userId as well as the token.
  it('omits the generateImage tool for an anonymous (no userId) turn even with a token', async () => {
    process.env.REPLICATE_API_TOKEN = 'test-token'
    const agent = await createResearcher({ model: 'openai:gpt-4o' })
    expect(getResearcherTools(agent)).not.toHaveProperty('generateImage')
  })
})

// The stable-knowledge gate. Ported from a flow-design experiment where a
// blind pairwise judge, over 46 turns, found that on the 18 turns where this
// architecture searched and a gated one did not, the gated one won 13-2 —
// searching a settled question produces a worse answer, not just a slower one.
//
// Asserted through resolveTurnMode rather than createResearcher because the
// agent keeps `instructions` and `activeTools` private, so the branch is
// otherwise unobservable from a test.
describe('resolveTurnMode', () => {
  it('routes a settled-knowledge question away from search', () => {
    // "explain closures in JavaScript" — the shape this gate exists for.
    expect(
      resolveTurnMode({
        skipSearch: false,
        needsSources: false,
        needsRecent: false
      })
    ).toBe('stable-knowledge')
  })

  it('still searches when the answer decays, even if marked sourceless', () => {
    // needsRecent and needsSources are independent, and needsRecent=true is an
    // explicit statement that parametric knowledge goes stale. Gating on
    // needsSources alone would have sent "latest Node.js version" to a prompt
    // that tells the model not to search.
    expect(
      resolveTurnMode({
        skipSearch: false,
        needsSources: false,
        needsRecent: true
      })
    ).toBe('research')
  })

  it('searches whenever sources are needed', () => {
    for (const needsRecent of [false, true]) {
      expect(
        resolveTurnMode({ skipSearch: false, needsSources: true, needsRecent })
      ).toBe('research')
    }
  })

  it('lets skipSearch win over the stable-knowledge gate', () => {
    // "answerable from this conversation" is a stronger claim than "answerable
    // from general knowledge", and its prompt reads the conversation rather
    // than ignoring it. Order matters here.
    expect(
      resolveTurnMode({
        skipSearch: true,
        needsSources: false,
        needsRecent: false
      })
    ).toBe('direct')
    expect(
      resolveTurnMode({
        skipSearch: true,
        needsSources: true,
        needsRecent: true
      })
    ).toBe('direct')
  })

  it('defaults to research when the caller passes nothing', () => {
    // THE SAFETY PROPERTY. Every existing call site that does not know about
    // needsSources — and the classifier's own failure fallback — must keep
    // searching exactly as before. The gate may only engage where something
    // deliberately said false.
    expect(resolveTurnMode({})).toBe('research')
    expect(resolveTurnMode({ skipSearch: false })).toBe('research')
  })
})
