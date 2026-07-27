import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const crossEncoderScore = vi.fn()
const isCrossEncoderConfigured = vi.fn(() => true)

vi.mock('@/lib/utils/cross-encoder', () => ({
  crossEncoderScore: (...args: unknown[]) => crossEncoderScore(...args),
  isCrossEncoderConfigured: () => isCrossEncoderConfigured()
}))

const c = (url: string, title = 't', content = 'body text') => ({
  url,
  title,
  content
})

async function freshModule() {
  vi.resetModules()
  return import('../snippet-gate')
}

describe('snippet gate config', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    crossEncoderScore.mockReset()
    isCrossEncoderConfigured.mockReturnValue(true)
  })
  afterEach(() => vi.unstubAllEnvs())

  it('defaults to off so a deploy with no env change is a no-op', async () => {
    const { snippetGateMode } = await freshModule()
    expect(snippetGateMode()).toBe('off')
  })

  it('reads shadow and on', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'shadow')
    expect((await freshModule()).snippetGateMode()).toBe('shadow')
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'on')
    expect((await freshModule()).snippetGateMode()).toBe('on')
  })

  it('treats an unrecognised value as off', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'yes-please')
    expect((await freshModule()).snippetGateMode()).toBe('off')
  })

  it('defaults topN to 20 and reads an override', async () => {
    expect((await freshModule()).snippetGateTopN()).toBe(20)
    vi.stubEnv('SEARCH_SNIPPET_GATE_TOP_N', '35')
    expect((await freshModule()).snippetGateTopN()).toBe(35)
  })

  it('falls back to 20 for a non-numeric topN', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE_TOP_N', 'lots')
    expect((await freshModule()).snippetGateTopN()).toBe(20)
  })
})

describe('runSnippetGate', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    crossEncoderScore.mockReset()
    isCrossEncoderConfigured.mockReturnValue(true)
  })
  afterEach(() => vi.unstubAllEnvs())

  it('does not call the reranker when off', async () => {
    const { runSnippetGate } = await freshModule()
    const out = await runSnippetGate('q', [c('a'), c('b')], new Set())
    expect(crossEncoderScore).not.toHaveBeenCalled()
    expect(out.status).toBe('off')
    expect(out.candidates.map(r => r.url)).toEqual(['a', 'b'])
  })

  it('scores but does not reorder candidates in shadow mode', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'shadow')
    crossEncoderScore.mockResolvedValue([0.1, 0.9])
    const { runSnippetGate } = await freshModule()
    const out = await runSnippetGate('q', [c('a'), c('b')], new Set())

    expect(crossEncoderScore).toHaveBeenCalledTimes(1)
    expect(out.status).toBe('shadow')
    // Crawl set unchanged — this is what makes shadow safe on prod.
    expect(out.candidates.map(r => r.url)).toEqual(['a', 'b'])
    // But the ranking IS reported.
    expect(out.rankByUrl.get('b')).toBe(0)
    expect(out.ranked).toBe(2)
    expect(out.capped).toBe(0)
  })

  it('reorders and caps in on mode', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'on')
    vi.stubEnv('SEARCH_SNIPPET_GATE_TOP_N', '2')
    crossEncoderScore.mockResolvedValue([0.1, 0.9, 0.5])
    const { runSnippetGate } = await freshModule()
    const out = await runSnippetGate('q', [c('a'), c('b'), c('d')], new Set())

    expect(out.status).toBe('on')
    expect(out.candidates.map(r => r.url)).toEqual(['b', 'd'])
    expect(out.capped).toBe(1)
  })

  it('keeps prefetched urls past the cap in on mode', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'on')
    vi.stubEnv('SEARCH_SNIPPET_GATE_TOP_N', '1')
    crossEncoderScore.mockResolvedValue([0.9, 0.5, 0.1])
    const { runSnippetGate } = await freshModule()
    const out = await runSnippetGate(
      'q',
      [c('a'), c('b'), c('d')],
      new Set(['d'])
    )
    expect(out.candidates.map(r => r.url)).toEqual(['a', 'd'])
  })

  it('falls back to the input order when the reranker throws', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'on')
    vi.stubEnv('SEARCH_SNIPPET_GATE_TOP_N', '1')
    crossEncoderScore.mockRejectedValue(new Error('reranker down'))
    const { runSnippetGate } = await freshModule()
    const out = await runSnippetGate('q', [c('a'), c('b')], new Set())

    expect(out.status).toBe('error')
    // Un-capped: a degraded reranker must never shrink the crawl set.
    expect(out.candidates.map(r => r.url)).toEqual(['a', 'b'])
  })

  it('is off when the reranker is not configured', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'on')
    isCrossEncoderConfigured.mockReturnValue(false)
    const { runSnippetGate } = await freshModule()
    const out = await runSnippetGate('q', [c('a')], new Set())
    expect(crossEncoderScore).not.toHaveBeenCalled()
    expect(out.status).toBe('off')
  })

  it('does not call the reranker for an empty pool', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'shadow')
    const { runSnippetGate } = await freshModule()
    const out = await runSnippetGate('q', [], new Set())
    expect(crossEncoderScore).not.toHaveBeenCalled()
    expect(out.candidates).toEqual([])
  })

  it('passes maxLength 128 and the configured timeout', async () => {
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'shadow')
    vi.stubEnv('SEARCH_SNIPPET_GATE_TIMEOUT_MS', '1234')
    crossEncoderScore.mockResolvedValue([0.5])
    const { runSnippetGate } = await freshModule()
    await runSnippetGate('q', [c('a')], new Set())
    expect(crossEncoderScore).toHaveBeenCalledWith('q', ['t\nbody text'], {
      maxLength: 128,
      timeoutMs: 1234
    })
  })
})
