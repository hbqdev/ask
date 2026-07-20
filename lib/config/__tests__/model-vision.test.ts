import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the Ollama client so vision detection is driven by a controllable
// `/api/show` capabilities response rather than a live Ollama instance.
const { getModelCapabilities } = vi.hoisted(() => ({
  getModelCapabilities: vi.fn()
}))
vi.mock('@/lib/ollama/client', () => ({
  OllamaClient: class {
    getModelCapabilities = getModelCapabilities
  }
}))

import { modelSupportsVision } from '../model-vision'

function caps(list: string[]) {
  return { name: 'm', capabilities: list, contextWindow: 0, parameters: {} }
}

const ORIGINAL_BASE_URL = process.env.OLLAMA_BASE_URL

describe('modelSupportsVision', () => {
  beforeEach(() => {
    getModelCapabilities.mockReset()
    process.env.OLLAMA_BASE_URL = 'http://ollama.test'
  })

  afterEach(() => {
    process.env.OLLAMA_BASE_URL = ORIGINAL_BASE_URL
  })

  it('honors an explicit vision flag without any Ollama lookup', async () => {
    // Explicit true wins even for an Ollama model that reports no vision.
    expect(
      await modelSupportsVision({
        id: 'explicit-true',
        providerId: 'ollama',
        vision: true
      })
    ).toBe(true)
    // Explicit false wins even for an Ollama model that reports vision.
    expect(
      await modelSupportsVision({
        id: 'explicit-false',
        providerId: 'ollama',
        vision: false
      })
    ).toBe(false)
    expect(getModelCapabilities).not.toHaveBeenCalled()
  })

  it('reports vision when Ollama /api/show lists the "vision" capability', async () => {
    getModelCapabilities.mockResolvedValue(caps(['completion', 'vision']))
    expect(
      await modelSupportsVision({ id: 'qwen3-vl:4b', providerId: 'ollama' })
    ).toBe(true)
    expect(getModelCapabilities).toHaveBeenCalledWith('qwen3-vl:4b')
  })

  it('reports no vision when Ollama capabilities lack "vision"', async () => {
    getModelCapabilities.mockResolvedValue(caps(['completion', 'tools']))
    expect(
      await modelSupportsVision({ id: 'qwen3:8b', providerId: 'ollama' })
    ).toBe(false)
  })

  it('falls back to text-only when Ollama is unreachable (safe direction)', async () => {
    getModelCapabilities.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(
      await modelSupportsVision({
        id: 'unreachable-model',
        providerId: 'ollama'
      })
    ).toBe(false)
  })

  it('does not query Ollama for a non-Ollama model without an explicit flag', async () => {
    expect(
      await modelSupportsVision({
        id: 'some-cloud-model',
        providerId: 'openai'
      })
    ).toBe(false)
    expect(getModelCapabilities).not.toHaveBeenCalled()
  })

  it('returns text-only (and skips the lookup) when OLLAMA_BASE_URL is unset', async () => {
    delete process.env.OLLAMA_BASE_URL
    expect(
      await modelSupportsVision({ id: 'no-base-url', providerId: 'ollama' })
    ).toBe(false)
    expect(getModelCapabilities).not.toHaveBeenCalled()
  })

  it('caches the resolved capability so repeated turns hit Ollama only once', async () => {
    getModelCapabilities.mockResolvedValue(caps(['vision']))
    const model = { id: 'cached-vl:latest', providerId: 'ollama' }
    expect(await modelSupportsVision(model)).toBe(true)
    expect(await modelSupportsVision(model)).toBe(true)
    expect(getModelCapabilities).toHaveBeenCalledTimes(1)
  })
})
