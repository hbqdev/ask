import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSearchTool } from '@/lib/tools/search'

// The search tool's toModelOutput strips UI-only fields (citationMap duplicates
// results; state is a streaming marker) from what the model sees. images MUST
// reach the model — getImageSpecPrompt tells it to embed image URLs verbatim
// from that array. All fields still survive in the streamed/persisted output
// for the UI.
describe('search tool toModelOutput', () => {
  const tool = createSearchTool('google:gemini-3-flash-preview')

  const fullOutput = {
    state: 'complete',
    query: 'test query',
    number_of_results: 2,
    results: [
      { title: 'A', url: 'https://a.test', content: 'alpha' },
      { title: 'B', url: 'https://b.test', content: 'beta' }
    ],
    images: [{ url: 'https://a.test/1.png' }],
    citationMap: {
      1: { title: 'A', url: 'https://a.test', content: 'alpha' },
      2: { title: 'B', url: 'https://b.test', content: 'beta' }
    },
    toolCallId: 'call_123'
  }

  it('omits citationMap and state from the model output', async () => {
    const modelOutput = await tool.toModelOutput?.({
      toolCallId: 'call_123',
      input: {} as never,
      output: fullOutput as never
    })

    expect(modelOutput).toBeDefined()
    expect(modelOutput?.type).toBe('json')
    const value = (
      modelOutput as { type: 'json'; value: Record<string, unknown> }
    ).value

    expect(value).not.toHaveProperty('citationMap')
    expect(value).not.toHaveProperty('state')
  })

  it('preserves the fields the model needs to answer and to cite', async () => {
    const modelOutput = await tool.toModelOutput?.({
      toolCallId: 'call_123',
      input: {} as never,
      output: fullOutput as never
    })
    const value = (
      modelOutput as { type: 'json'; value: Record<string, unknown> }
    ).value

    expect(value.results).toEqual(fullOutput.results)
    expect(value.query).toBe('test query')
    expect(value.number_of_results).toBe(2)
    // images MUST reach the model — the prompt embeds their URLs verbatim.
    expect(value.images).toEqual(fullOutput.images)
    // toolCallId is required: the prompt cites as [number](#toolCallId).
    expect(value.toolCallId).toBe('call_123')
  })

  it('does not mutate the original output (UI/persistence keep all fields)', async () => {
    await tool.toModelOutput?.({
      toolCallId: 'call_123',
      input: {} as never,
      output: fullOutput as never
    })

    expect(fullOutput).toHaveProperty('citationMap')
    expect(fullOutput).toHaveProperty('images')
  })

  it('handles non-object output defensively', async () => {
    const modelOutput = await tool.toModelOutput?.({
      toolCallId: 'call_123',
      input: {} as never,
      output: null as never
    })

    expect(modelOutput).toEqual({ type: 'json', value: null })
  })
})

// CITATION_HANDLES: each result the model sees carries its ready-made
// `cite` string, built from the toolCallId the SDK passes toModelOutput (the
// id the UI part is stored under). Off = the previous model view exactly.
describe('search tool toModelOutput — CITATION_HANDLES', () => {
  const tool = createSearchTool('google:gemini-3-flash-preview')
  const liveOutput = {
    state: 'complete',
    query: 'node 24',
    number_of_results: 2,
    results: [
      { title: 'A', url: 'https://a.test/', content: 'alpha' },
      { title: 'B', url: 'https://b.test/', content: 'beta' }
    ],
    images: [],
    toolCallId: 'call_live'
  }
  const run = async () =>
    (
      (await tool.toModelOutput?.({
        toolCallId: 'call_live',
        input: {} as never,
        output: liveOutput as never
      })) as { type: 'json'; value: Record<string, any> }
    ).value

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('on (default): every result carries [N](#toolCallId) for its position', async () => {
    vi.stubEnv('CITATION_HANDLES', '')
    const value = await run()
    expect(value.results.map((r: { cite: string }) => r.cite)).toEqual([
      '[1](#call_live)',
      '[2](#call_live)'
    ])
    // Only the cite is added; the rest of the view is unchanged.
    expect(value).not.toHaveProperty('state')
    expect(value.toolCallId).toBe('call_live')
    expect(liveOutput.results[0]).not.toHaveProperty('cite')
  })

  it('off: the model view is exactly the pre-CITATION_HANDLES one', async () => {
    vi.stubEnv('CITATION_HANDLES', 'off')
    const value = await run()
    const { state: _state, ...expected } = liveOutput
    expect(JSON.stringify(value)).toBe(JSON.stringify(expected))
  })
})
