import { NextRequest } from 'next/server'

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/get-current-user', () => ({
  getCurrentUserId: vi.fn()
}))
vi.mock('@/lib/db/model-preference-actions', () => ({
  savePreferredChatModel: vi.fn()
}))
vi.mock('@/lib/models/fetch-models', () => ({
  fetchAvailableModels: vi.fn()
}))

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { savePreferredChatModel } from '@/lib/db/model-preference-actions'
import { fetchAvailableModels } from '@/lib/models/fetch-models'

import { PUT } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCurrentUserId).mockResolvedValue('u1')
  vi.mocked(savePreferredChatModel).mockResolvedValue(undefined)
  vi.mocked(fetchAvailableModels).mockResolvedValue({
    ollama: [
      {
        id: 'kimi-k2.6:cloud',
        name: 'Kimi K2.6',
        provider: 'Ollama',
        providerId: 'ollama'
      }
    ],
    openai: [
      { id: 'gpt-5', name: 'GPT-5', provider: 'OpenAI', providerId: 'openai' }
    ]
  })
})

function makeRequest(body: unknown, raw = false): NextRequest {
  return new NextRequest('http://localhost:3000/api/settings/model', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body)
  })
}

describe('PUT /api/settings/model', () => {
  it('returns 401 without a user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined as any)

    const res = await PUT(
      makeRequest({ providerId: 'ollama', modelId: 'kimi-k2.6:cloud' })
    )

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expect(savePreferredChatModel).not.toHaveBeenCalled()
  })

  it('returns 400 for a model not in the list', async () => {
    // Unknown model id, and a known id under the wrong provider.
    for (const body of [
      { providerId: 'ollama', modelId: 'not-a-model' },
      { providerId: 'openai', modelId: 'kimi-k2.6:cloud' }
    ]) {
      const res = await PUT(makeRequest(body))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid model' })
    }
    expect(savePreferredChatModel).not.toHaveBeenCalled()
  })

  it('returns 400 for a missing field or malformed JSON', async () => {
    const requests = [
      makeRequest({ providerId: 'ollama' }),
      makeRequest({ modelId: 'kimi-k2.6:cloud' }),
      makeRequest({ providerId: 'ollama', modelId: 42 }),
      makeRequest({ providerId: '', modelId: 'kimi-k2.6:cloud' }),
      makeRequest(null),
      makeRequest('{not json', true)
    ]
    for (const req of requests) {
      const res = await PUT(req)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid model' })
    }
    expect(savePreferredChatModel).not.toHaveBeenCalled()
  })

  it('saves and returns the key', async () => {
    const res = await PUT(
      makeRequest({ providerId: 'ollama', modelId: 'kimi-k2.6:cloud' })
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      selectedModelKey: 'ollama:kimi-k2.6:cloud'
    })
    expect(savePreferredChatModel).toHaveBeenCalledWith(
      'u1',
      'ollama',
      'kimi-k2.6:cloud'
    )
  })
})
