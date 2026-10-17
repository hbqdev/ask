import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('ai', () => ({ generateText: vi.fn() }))
// Records the (modelId, options) the provider is called with, so the test can
// assert the default generate path turns thinking off. Without think:false a
// thinking-capable model spends the whole 8s gist budget reasoning and every
// call falls back to firstSentences.
const providerCall = vi.fn((id: string, opts?: unknown) => ({ id, opts }))
vi.mock('ai-sdk-ollama', () => ({
  createOllama: vi.fn(() => providerCall)
}))

import { generateText } from 'ai'

import { condenseForSpeech } from '../spoken-gist'

describe('condenseForSpeech default generate', () => {
  beforeEach(() => {
    vi.mocked(generateText).mockReset()
    providerCall.mockClear()
    process.env.VOICE_GIST_MODEL_ID = 'test-gist:1b'
  })

  afterAll(() => {
    delete process.env.VOICE_GIST_MODEL_ID
  })

  it('calls the gist model with think:false and keep_alive:-1', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'Short gist.' } as any)

    const out = await condenseForSpeech('A long answer. With sentences.')

    expect(out).toBe('Short gist.')
    expect(providerCall).toHaveBeenCalledWith('test-gist:1b', {
      think: false,
      keep_alive: -1
    })
    expect(vi.mocked(generateText).mock.calls[0][0].model).toEqual({
      id: 'test-gist:1b',
      opts: { think: false, keep_alive: -1 }
    })
  })
})
