import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/model-selector/get-model-selector-data', () => ({
  getModelSelectorData: vi.fn()
}))

import { getModelSelectorData } from '@/lib/model-selector/get-model-selector-data'

import { GET } from '../route'

const data = {
  enabled: true,
  modelsByProvider: {
    ollama: [
      {
        id: 'kimi-k2.6:cloud',
        name: 'Kimi K2.6',
        provider: 'Ollama',
        providerId: 'ollama'
      }
    ]
  },
  selectedModelKey: 'ollama:kimi-k2.6:cloud',
  hasAvailableModels: true
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getModelSelectorData).mockResolvedValue(data)
})

describe('GET /api/models', () => {
  it('returns model selector data with no-store', async () => {
    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(json).toEqual(data)
    expect(getModelSelectorData).toHaveBeenCalledTimes(1)
  })
})
