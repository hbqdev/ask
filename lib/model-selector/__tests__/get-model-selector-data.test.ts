import { describe, expect, it, vi } from 'vitest'

import { Model } from '@/lib/types/models'

vi.mock('@/lib/utils/registry', () => ({
  isProviderEnabled: vi.fn(() => true)
}))
vi.mock('@/lib/config/default-model', () => ({
  DEFAULT_MODEL: {
    id: 'kimi-k2.6:cloud',
    name: 'kimi-k2.6:cloud',
    provider: 'Ollama',
    providerId: 'ollama'
  }
}))

import { isProviderEnabled } from '@/lib/utils/registry'

import { pickFallbackModel } from '../pick-fallback-model'

const ollama = (id: string): Model => ({
  id,
  name: id,
  provider: 'Ollama Cloud',
  providerId: 'ollama'
})

const LIST: Record<string, Model[]> = {
  ollama: [
    ollama('deepseek-v4-flash:cloud'),
    ollama('kimi-k2.6:cloud'),
    ollama('qwen3.5:397b:cloud')
  ]
}

describe('pickFallbackModel', () => {
  it('prefers DEFAULT_MODEL when it is in the fetched list', () => {
    expect(pickFallbackModel(LIST)?.id).toBe('kimi-k2.6:cloud')
  })

  it('falls back to the first available model when DEFAULT_MODEL is not listed', () => {
    const withoutKimi: Record<string, Model[]> = {
      ollama: [ollama('deepseek-v4-flash:cloud'), ollama('qwen3.5:397b:cloud')]
    }
    expect(pickFallbackModel(withoutKimi)?.id).toBe('deepseek-v4-flash:cloud')
  })

  it("falls back to the first available model when DEFAULT_MODEL's provider is disabled", () => {
    vi.mocked(isProviderEnabled).mockReturnValueOnce(false)
    expect(pickFallbackModel(LIST)?.id).toBe('deepseek-v4-flash:cloud')
  })

  it('returns null when nothing is available', () => {
    expect(pickFallbackModel({})).toBeNull()
  })
})
