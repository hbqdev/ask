import { DEFAULT_MODEL } from '@/lib/config/default-model'
import { Model } from '@/lib/types/models'
import { SearchMode } from '@/lib/types/search'

import { getModelsConfig, isCloudDeployment } from './load-models-config'

// Retrieve the cloud model assigned to a specific search mode.
export function getModelForMode(mode: SearchMode): Model | undefined {
  if (!isCloudDeployment()) {
    return undefined
  }

  const cfg = getModelsConfig()
  return cfg.models?.[mode]
}

// Accessor for related questions model.
// In local/docker, reuse the selected local model when available to keep
// provider routing consistent with the main chat flow.
export function getRelatedQuestionsModel(localSelectedModel?: Model): Model {
  if (!isCloudDeployment()) {
    return localSelectedModel ?? DEFAULT_MODEL
  }

  const cfg = getModelsConfig()
  return cfg.models.relatedQuestions
}
