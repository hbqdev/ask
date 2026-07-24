import { cookies } from 'next/headers'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { DEFAULT_MODEL } from '@/lib/config/default-model'
import {
  MODEL_SELECTION_COOKIE,
  type ParsedModelSelectionCookie,
  parseModelSelectionCookie
} from '@/lib/config/model-selection-cookie'
import { getPreferredChatModel } from '@/lib/db/model-preference-actions'
import { pickFallbackModel } from '@/lib/model-selector/pick-fallback-model'
import { fetchAvailableModels } from '@/lib/models/fetch-models'
import { ModelSelectorData } from '@/lib/types/model-selector'
import { Model } from '@/lib/types/models'
import { isProviderEnabled } from '@/lib/utils/registry'

import 'server-only'

function modelKey(model: Model): string {
  return `${model.providerId}:${model.id}`
}

// pickFallbackModel lives in its own module (no server-only import) so it
// stays unit-testable; see lib/model-selector/pick-fallback-model.ts.

function resolveSelectedModelKey(
  modelsByProvider: Record<string, Model[]>,
  fallbackModel: Model | null,
  pick: ParsedModelSelectionCookie | null
): string {
  if (!pick) {
    return fallbackModel ? modelKey(fallbackModel) : ''
  }

  const matched = Object.values(modelsByProvider)
    .flat()
    .some(
      model => model.providerId === pick.providerId && model.id === pick.modelId
    )

  return matched
    ? `${pick.providerId}:${pick.modelId}`
    : fallbackModel
      ? modelKey(fallbackModel)
      : ''
}

export async function getModelSelectorData(): Promise<ModelSelectorData> {
  if (process.env.MORPHIC_CLOUD_DEPLOYMENT === 'true') {
    return {
      enabled: false,
      modelsByProvider: {},
      selectedModelKey: '',
      hasAvailableModels: false
    }
  }

  const modelsByProvider = await fetchAvailableModels()
  const fallbackModel = pickFallbackModel(modelsByProvider)
  const hasAvailableModels =
    fallbackModel !== null || isProviderEnabled(DEFAULT_MODEL.providerId)

  // Same source-of-truth split as selectModel: authenticated sessions read
  // the account's saved pick (cookie ignored — login boundary); guests read
  // the cookie.
  const userId = await getCurrentUserId()
  let pick: ParsedModelSelectionCookie | null
  if (userId) {
    pick = await getPreferredChatModel(userId)
  } else {
    const cookieStore = await cookies()
    pick = parseModelSelectionCookie(
      cookieStore.get(MODEL_SELECTION_COOKIE)?.value
    )
  }
  const selectedModelKey = resolveSelectedModelKey(
    modelsByProvider,
    fallbackModel,
    pick
  )

  return {
    enabled: true,
    modelsByProvider,
    selectedModelKey,
    hasAvailableModels
  }
}
