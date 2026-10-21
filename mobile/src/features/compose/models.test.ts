import { describe, expect, it, vi } from 'vitest'

import { createApiClient } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'
import { fetchModels, modelKey, saveModel } from '@/features/compose/models'
import type { ModelSelectorData } from '@/lib/types/model-selector'

const DATA: ModelSelectorData = {
  enabled: true,
  hasAvailableModels: true,
  selectedModelKey: 'ollama:qwen3',
  modelsByProvider: {
    Ollama: [
      { id: 'qwen3', name: 'Qwen 3', provider: 'Ollama', providerId: 'ollama' }
    ]
  }
}

function client(response: Response) {
  const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) =>
    response.clone()
  )
  return {
    fetchImpl,
    client: createApiClient({
      baseUrl: 'https://ask.example',
      getToken: async () => 'token',
      fetchImpl
    })
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

describe('modelKey', () => {
  it('joins the provider id and model id as the server does', () => {
    expect(modelKey({ providerId: 'ollama', id: 'qwen3' })).toBe('ollama:qwen3')
  })
})

describe('fetchModels', () => {
  it('GETs /api/models and returns the selector data', async () => {
    const { client: api, fetchImpl } = client(json(DATA))
    await expect(fetchModels(api)).resolves.toEqual(DATA)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://ask.example/api/models')
    expect(init?.method ?? 'GET').toBe('GET')
  })

  it('rejects with an ApiError for a failed response', async () => {
    const { client: api } = client(new Response('Server down', { status: 500 }))
    const error = await fetchModels(api).catch(e => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(500)
  })
})

describe('saveModel', () => {
  it('PUTs the provider and model ids and returns the selected key', async () => {
    const { client: api, fetchImpl } = client(
      json({ ok: true, selectedModelKey: 'ollama:qwen3' })
    )
    await expect(saveModel(api, 'ollama', 'qwen3')).resolves.toBe(
      'ollama:qwen3'
    )
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://ask.example/api/settings/model')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(String(init?.body))).toEqual({
      providerId: 'ollama',
      modelId: 'qwen3'
    })
    expect(new Headers(init?.headers).get('Content-Type')).toBe(
      'application/json'
    )
  })

  it('rejects with the server error as an ApiError', async () => {
    const { client: api } = client(json({ error: 'Invalid model' }, 400))
    const error = await saveModel(api, 'ollama', 'gone').catch(e => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(400)
    expect(error.message).toBe('Invalid model')
  })
})
