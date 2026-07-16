import { generateText } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { extractMemories } from '../memory-extractor'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return { ...actual, generateText: vi.fn() }
})
vi.mock('ai-sdk-ollama', () => ({
  createOllama: vi.fn(() => vi.fn(modelId => ({ modelId })))
}))
vi.mock('../../utils/fetch-with-timeout', () => ({
  createTimeoutFetch: vi.fn(() => vi.fn())
}))

const mockGen = vi.mocked(generateText)

describe('extractMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CLASSIFIER_OLLAMA_BASE_URL = 'http://serenity:11434'
  })
  afterEach(() => {
    delete process.env.CLASSIFIER_OLLAMA_BASE_URL
  })

  it('returns extracted candidates', async () => {
    mockGen.mockResolvedValue({
      output: {
        memories: [
          { content: 'Self-hosts their infrastructure', category: 'fact' }
        ]
      }
    } as any)
    const res = await extractMemories({
      userMessage: 'I run everything self-hosted on my own boxes'
    })
    expect(res).toEqual([
      { content: 'Self-hosts their infrastructure', category: 'fact' }
    ])
  })

  it('returns [] when the model finds nothing durable', async () => {
    mockGen.mockResolvedValue({ output: { memories: [] } } as any)
    expect(await extractMemories({ userMessage: 'what time is it' })).toEqual(
      []
    )
  })

  it('returns [] on model error (fail-safe)', async () => {
    mockGen.mockRejectedValue(new Error('serenity down'))
    expect(await extractMemories({ userMessage: 'anything' })).toEqual([])
  })

  it('returns [] when the classifier host is unset', async () => {
    delete process.env.CLASSIFIER_OLLAMA_BASE_URL
    delete process.env.OLLAMA_BASE_URL
    expect(await extractMemories({ userMessage: 'x' })).toEqual([])
  })
})
