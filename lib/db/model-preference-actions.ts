import { eq } from 'drizzle-orm'

import {
  type ParsedModelSelectionCookie,
  parseModelSelectionCookie,
  serializeModelSelectionCookie
} from '@/lib/config/model-selection-cookie'

import { userSettings } from './schema'
import { withOptionalRLS } from './with-rls'

/**
 * The user's last EXPLICITLY picked chat model, or null when they never
 * picked (→ caller falls back to the deployment default). Stored in the
 * same `providerId:modelId` serialization the selection cookie uses.
 */
export async function getPreferredChatModel(
  userId: string | null | undefined
): Promise<ParsedModelSelectionCookie | null> {
  if (!userId) return null
  try {
    return await withOptionalRLS(userId, async tx => {
      const rows = await tx
        .select({ preferred: userSettings.preferredChatModel })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1)
      return parseModelSelectionCookie(rows[0]?.preferred)
    })
  } catch (error) {
    // A read failure must never take down model selection — fall back to
    // the default-model chain.
    console.warn('[model-preference] read failed:', error)
    return null
  }
}

/**
 * Persist an explicit model pick for the account (upsert on the settings
 * row). No-ops without a user id (guest/anonymous sessions stay
 * cookie-only). Best-effort: a write failure only costs cross-device
 * memory of the pick.
 */
export async function savePreferredChatModel(
  userId: string | null | undefined,
  providerId: string,
  modelId: string
): Promise<void> {
  if (!userId || !providerId || !modelId) return
  const serialized = serializeModelSelectionCookie({ providerId, modelId })
  try {
    await withOptionalRLS(userId, async tx => {
      await tx
        .insert(userSettings)
        .values({ userId, preferredChatModel: serialized })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: { preferredChatModel: serialized, updatedAt: new Date() }
        })
    })
  } catch (error) {
    console.warn('[model-preference] save failed:', error)
  }
}
