import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Model } from '@/lib/types/models'

import {
  __resetContextWindowCacheForTests,
  resolveContextWindow
} from '../resolve-context-window'

const ollama = (id: string): Model =>
  ({ id, name: id, provider: 'Ollama', providerId: 'ollama' }) as Model
const openai = (id: string): Model =>
  ({ id, name: id, provider: 'OpenAI', providerId: 'openai' }) as Model

function showResponse(archKey: string, length: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ model_info: { [archKey]: length } })
  } as Response
}

beforeEach(() => {
  vi.restoreAllMocks()
  __resetContextWindowCacheForTests()
  process.env.OLLAMA_BASE_URL = 'http://ollama.test:11434'
})
afterEach(() => {
  delete process.env.OLLAMA_BASE_URL
})

describe('resolveContextWindow', () => {
  it('reads the real window from ollama, whatever the architecture prefix is', async () => {
    // Ollama namespaces the key by architecture: kimi-k2.context_length,
    // llama.context_length, qwen3.context_length. Matching on the suffix is
    // what makes this work for models we have never seen.
    vi.spyOn(global, 'fetch').mockResolvedValue(
      showResponse('kimi-k2.context_length', 262144)
    )
    await expect(resolveContextWindow(ollama('kimi-k2.6:cloud'))).resolves.toBe(
      262144
    )
  })

  it('prefers a known static window over probing', async () => {
    const f = vi.spyOn(global, 'fetch')
    await expect(resolveContextWindow(openai('gpt-4.1'))).resolves.toBe(128000)
    expect(f).not.toHaveBeenCalled()
  })

  it('probes once per model and serves the rest from cache', async () => {
    const f = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(showResponse('qwen3.context_length', 40960))

    await resolveContextWindow(ollama('qwen3:8b'))
    await resolveContextWindow(ollama('qwen3:8b'))
    await resolveContextWindow(ollama('qwen3:8b'))

    expect(f).toHaveBeenCalledTimes(1)
  })

  it('returns null — meaning do not truncate — when the probe fails', async () => {
    // The whole point of this change: never invent a small window. An
    // unknown window must disable truncation, not fall back to a default
    // that silently discards conversation history.
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ollama down'))
    await expect(
      resolveContextWindow(ollama('mystery:latest'))
    ).resolves.toBeNull()
  })

  it('returns null when the response carries no context_length', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ model_info: { 'kimi-k2.embedding_length': 7168 } })
    } as Response)
    await expect(resolveContextWindow(ollama('odd:latest'))).resolves.toBeNull()
  })

  it('caches a failure so a down ollama does not add a probe to every turn', async () => {
    const f = vi
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('ollama down'))

    await resolveContextWindow(ollama('mystery:latest'))
    await resolveContextWindow(ollama('mystery:latest'))

    expect(f).toHaveBeenCalledTimes(1)
  })

  it('returns null for a non-ollama provider we have no entry for', async () => {
    const f = vi.spyOn(global, 'fetch')
    await expect(
      resolveContextWindow({
        id: 'some-new-model',
        name: 'x',
        provider: 'X',
        providerId: 'anthropic'
      } as Model)
    ).resolves.toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it('ignores a non-numeric context_length rather than trusting it', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ model_info: { 'llama.context_length': 'lots' } })
    } as Response)
    await expect(
      resolveContextWindow(ollama('weird:latest'))
    ).resolves.toBeNull()
  })
})
