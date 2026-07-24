'use server'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { savePreferredChatModel } from '@/lib/db/model-preference-actions'

/**
 * Persist the current user's explicit model pick. The user id is derived
 * server-side (never trusted from the client); guests no-op and stay
 * cookie-only.
 */
export async function saveModelPreference(
  providerId: string,
  modelId: string
): Promise<void> {
  const userId = await getCurrentUserId()
  if (!userId) return
  await savePreferredChatModel(userId, providerId, modelId)
}
