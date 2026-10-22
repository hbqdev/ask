import type { User } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/model-selector/get-model-selector-data', () => ({
  getModelSelectorData: vi.fn()
}))
// Real isBearerAuthorization; only the user resolution is stubbed.
vi.mock('@/lib/auth/get-current-user', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/auth/get-current-user')>()),
  getCurrentUser: vi.fn()
}))

import { getCurrentUser } from '@/lib/auth/get-current-user'
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
  vi.stubEnv('ENABLE_AUTH', 'true')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/models', { headers })
}

describe('GET /api/models', () => {
  it('returns model selector data with no-store', async () => {
    const res = await GET(request())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(json).toEqual(data)
    expect(getModelSelectorData).toHaveBeenCalledTimes(1)
    expect(getCurrentUser).not.toHaveBeenCalled()
  })

  it('401 for an invalid bearer', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)

    const res = await GET(request({ authorization: 'Bearer bad' }))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expect(getModelSelectorData).not.toHaveBeenCalled()
  })

  it('a valid bearer gets the model data as before', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user-1' } as User)

    const res = await GET(request({ authorization: 'Bearer good' }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual(data)
  })
})
