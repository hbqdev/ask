import { cookies } from 'next/headers'

import { DEFAULT_MODEL } from '@/lib/config/default-model'
import {
  MODEL_SELECTION_COOKIE,
  parseModelSelectionCookie
} from '@/lib/config/model-selection-cookie'
import { fetchAvailableModels } from '@/lib/models/fetch-models'
import { ModelSelectorData } from '@/lib/types/model-selector'
import { Model } from '@/lib/types/models'

import 'server-only'

function ensureModelInGroup(
  modelsByProvider: Record<string, Model[]>,
  model: Model
): Record<string, Model[]> {
  const next = { ...modelsByProvider }
  const providerModels = next[model.provider] ?? []
  const exists = providerModels.some(
    item => item.id === model.id && item.providerId === model.providerId
  )

  if (!exists) {
    next[model.provider] = [...providerModels, model].sort((a, b) =>
      a.name.localeCompare(b.name)
    )
  }

  return next
}

function modelKey(model: Model): string {
  return `${model.providerId}:${model.id}`
}

function resolveSelectedModelKey(
  modelsByProvider: Record<string, Model[]>,
  defaultModel: Model,
  cookieValue?: string
): string {
  const parsedCookie = parseModelSelectionCookie(cookieValue)
  if (!parsedCookie) {
    return modelKey(defaultModel)
  }

  const matched = Object.values(modelsByProvider)
    .flat()
    .some(
      model =>
        model.providerId === parsedCookie.providerId &&
        model.id === parsedCookie.modelId
    )

  return matched
    ? `${parsedCookie.providerId}:${parsedCookie.modelId}`
    : modelKey(defaultModel)
}

export async function getModelSelectorData(): Promise<ModelSelectorData> {
  if (process.env.MORPHIC_CLOUD_DEPLOYMENT === 'true') {
    return {
      enabled: false,
      modelsByProvider: {},
      defaultModel: DEFAULT_MODEL,
      selectedModelKey: modelKey(DEFAULT_MODEL)
    }
  }

  const fetchedModels = await fetchAvailableModels()
  const modelsByProvider = ensureModelInGroup(fetchedModels, DEFAULT_MODEL)
  const cookieStore = await cookies()
  const selectedModelKey = resolveSelectedModelKey(
    modelsByProvider,
    DEFAULT_MODEL,
    cookieStore.get(MODEL_SELECTION_COOKIE)?.value
  )

  return {
    enabled: true,
    modelsByProvider,
    defaultModel: DEFAULT_MODEL,
    selectedModelKey
  }
}
