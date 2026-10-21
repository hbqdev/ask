// The answering model: the list the server offers and the signed-in user's
// pick. The pick is saved on the server (the chat body never names a model),
// so it follows the user to the web app too.

import type { ApiClient } from '@/core/api/client'
import type { ModelSelectorData } from '@/lib/types/model-selector'
import type { Model } from '@/lib/types/models'

/** A model's key as the server writes `selectedModelKey`: `provider:model`. */
export function modelKey(model: Pick<Model, 'providerId' | 'id'>): string {
  return `${model.providerId}:${model.id}`
}

/** The enabled models by provider, and the user's current pick. */
export function fetchModels(client: ApiClient): Promise<ModelSelectorData> {
  return client.json<ModelSelectorData>('/api/models')
}

/** Saves the user's pick; resolves with the server's `selectedModelKey`. */
export async function saveModel(
  client: ApiClient,
  providerId: string,
  modelId: string
): Promise<string> {
  const { selectedModelKey } = await client.json<{ selectedModelKey: string }>(
    '/api/settings/model',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, modelId })
    }
  )
  return selectedModelKey
}
