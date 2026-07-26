import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Expansion costs a second serial call to granite4.1:8b on the same GPU host
// as the classifier — measured at 8.2-12.3s on every research turn. Neither
// upstream Morphic nor Vane has a query expander at all (git grep returns zero
// files upstream; Vane's classifier does a standalone rewrite in the SAME call
// and no multi-query expansion). Before removing or keeping it, it needs an
// off switch so the two arms can be compared on one build.
// vi.mock is hoisted above module scope, so the spy has to be created inside
// vi.hoisted or it is not initialised when the factory runs.
const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }))
vi.mock('ai', async importOriginal => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: generateTextMock }
})

import { expandQuery } from '../query-expander'

beforeEach(() => {
  generateTextMock.mockReset()
  generateTextMock.mockResolvedValue({ output: { queries: ['a', 'b'] } })
  process.env.OLLAMA_BASE_URL = 'http://ollama.test:11434'
})
afterEach(() => {
  delete process.env.QUERY_EXPANSION_ENABLED
  delete process.env.OLLAMA_BASE_URL
})

describe('expandQuery expansion gate', () => {
  it('expands by default, so the flag has to be set to change behaviour', async () => {
    delete process.env.QUERY_EXPANSION_ENABLED
    await expect(
      expandQuery({ standaloneQuery: 'why is the sky blue' })
    ).resolves.toEqual(['a', 'b'])
    expect(generateTextMock).toHaveBeenCalledTimes(1)
  })

  it('returns [] and makes NO model call when expansion is disabled', async () => {
    // The point of the A/B is removing the latency, so the call must not
    // happen at all — returning [] after still paying for it proves nothing.
    process.env.QUERY_EXPANSION_ENABLED = 'false'
    await expect(
      expandQuery({ standaloneQuery: 'why is the sky blue' })
    ).resolves.toEqual([])
    expect(generateTextMock).not.toHaveBeenCalled()
  })

  it('treats only the exact string false as off', async () => {
    process.env.QUERY_EXPANSION_ENABLED = 'no'
    await expect(
      expandQuery({ standaloneQuery: 'why is the sky blue' })
    ).resolves.toEqual(['a', 'b'])
    expect(generateTextMock).toHaveBeenCalledTimes(1)
  })

  it('still returns [] with no model call for a blank query', async () => {
    await expect(expandQuery({ standaloneQuery: '   ' })).resolves.toEqual([])
    expect(generateTextMock).not.toHaveBeenCalled()
  })
})
