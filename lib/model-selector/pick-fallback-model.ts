import { DEFAULT_MODEL } from '@/lib/config/default-model'
import { Model } from '@/lib/types/models'
import { isProviderEnabled } from '@/lib/utils/registry'

function pickFirstAvailableModel(
  modelsByProvider: Record<string, Model[]>
): Model | null {
  const providers = Object.keys(modelsByProvider).sort((a, b) =>
    a.localeCompare(b)
  )

  for (const provider of providers) {
    const firstModel = modelsByProvider[provider]?.[0]
    if (firstModel) {
      return firstModel
    }
  }

  return null
}

/**
 * The no-cookie selection the UI shows. Prefers DEFAULT_MODEL when its
 * provider is enabled and it is actually in the fetched list, so the selector
 * displays the same model selectModel() will answer with; otherwise falls
 * back to the first available model.
 */
export function pickFallbackModel(
  modelsByProvider: Record<string, Model[]>
): Model | null {
  if (isProviderEnabled(DEFAULT_MODEL.providerId)) {
    const listed = Object.values(modelsByProvider)
      .flat()
      .find(
        model =>
          model.providerId === DEFAULT_MODEL.providerId &&
          model.id === DEFAULT_MODEL.id
      )
    if (listed) {
      return listed
    }
  }
  return pickFirstAvailableModel(modelsByProvider)
}
