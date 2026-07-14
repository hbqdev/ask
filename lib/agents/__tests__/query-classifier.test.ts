import { generateText } from 'ai'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { classifyQuery } from '../query-classifier'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    generateText: vi.fn()
  }
})

vi.mock('ai-sdk-ollama', () => ({
  createOllama: vi.fn(() => vi.fn(modelId => ({ modelId })))
}))

vi.mock('../../utils/fetch-with-timeout', () => ({
  createTimeoutFetch: vi.fn(() => vi.fn())
}))

const mockGenerateText = vi.mocked(generateText)

function userMsg(text: string) {
  return {
    id: '1',
    role: 'user' as const,
    parts: [{ type: 'text' as const, text }]
  }
}

function assistantMsg(text: string) {
  return {
    id: '2',
    role: 'assistant' as const,
    parts: [{ type: 'text' as const, text }]
  }
}

describe('classifyQuery', () => {
  const originalOllamaUrl = process.env.OLLAMA_BASE_URL
  const originalClassifierOllamaUrl = process.env.CLASSIFIER_OLLAMA_BASE_URL

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    delete process.env.CLASSIFIER_OLLAMA_BASE_URL
  })

  afterAll(() => {
    process.env.OLLAMA_BASE_URL = originalOllamaUrl
    process.env.CLASSIFIER_OLLAMA_BASE_URL = originalClassifierOllamaUrl
  })

  it('returns the model classification on success', async () => {
    mockGenerateText.mockResolvedValue({
      output: { skipSearch: true, standaloneQuery: 'confirm the plan' }
    } as any)

    const result = await classifyQuery({
      messages: [
        userMsg('sonarr regex to exclude CAM releases'),
        assistantMsg('Option 1: X. Option 2: Y. Best practice: do both.'),
        userMsg('so you are saying to do both, right?')
      ]
    })

    expect(result).toEqual({
      skipSearch: true,
      standaloneQuery: 'confirm the plan'
    })
  })

  it('falls back to always-search using the raw latest message when the model call throws', async () => {
    mockGenerateText.mockRejectedValue(new Error('model unavailable'))

    const result = await classifyQuery({
      messages: [userMsg('what is the tallest mountain in South Korea')]
    })

    expect(result).toEqual({
      skipSearch: false,
      standaloneQuery: 'what is the tallest mountain in South Korea'
    })
  })

  it('falls back when the model returns an empty standaloneQuery', async () => {
    mockGenerateText.mockResolvedValue({
      output: { skipSearch: true, standaloneQuery: '   ' }
    } as any)

    const result = await classifyQuery({
      messages: [userMsg('hello there')]
    })

    expect(result).toEqual({
      skipSearch: false,
      standaloneQuery: 'hello there'
    })
  })

  it('falls back immediately without calling the model when OLLAMA_BASE_URL is not configured', async () => {
    delete process.env.OLLAMA_BASE_URL

    const result = await classifyQuery({
      messages: [userMsg('what time is it')]
    })

    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(result).toEqual({
      skipSearch: false,
      standaloneQuery: 'what time is it'
    })
  })

  it('prefers CLASSIFIER_OLLAMA_BASE_URL over OLLAMA_BASE_URL when both are set', async () => {
    process.env.CLASSIFIER_OLLAMA_BASE_URL = 'http://serenity:11434'
    mockGenerateText.mockResolvedValue({
      output: { skipSearch: false, standaloneQuery: 'what time is it' }
    } as any)

    await classifyQuery({ messages: [userMsg('what time is it')] })

    const { createOllama } = await import('ai-sdk-ollama')
    expect(createOllama).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://serenity:11434' })
    )
  })
})
