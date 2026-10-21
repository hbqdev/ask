import { NextRequest } from 'next/server'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { savePreferredChatModel } from '@/lib/db/model-preference-actions'
import { fetchAvailableModels } from '@/lib/models/fetch-models'

const invalidModel = () =>
  Response.json({ error: 'Invalid model' }, { status: 400 })

/**
 * Save the signed-in user's model pick — the non-browser counterpart of the
 * saveModelPreference server action. For signed-in users the chat route
 * selects the model solely from this DB preference, so this is how a native
 * client chooses its model. The pair must be a currently enabled model.
 */
export async function PUT(req: NextRequest) {
  const userId = await getCurrentUserId()
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return invalidModel()
  }

  const { providerId, modelId } = (body ?? {}) as Record<string, unknown>
  if (
    typeof providerId !== 'string' ||
    typeof modelId !== 'string' ||
    !providerId ||
    !modelId
  ) {
    return invalidModel()
  }

  const modelsByProvider = await fetchAvailableModels()
  const exists = Object.values(modelsByProvider)
    .flat()
    .some(model => model.providerId === providerId && model.id === modelId)
  if (!exists) return invalidModel()

  await savePreferredChatModel(userId, providerId, modelId)

  return Response.json({
    ok: true,
    selectedModelKey: `${providerId}:${modelId}`
  })
}
