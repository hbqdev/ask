'use server'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import {
  clearChunks,
  countChunks,
  isRecallEnabled,
  setRecallEnabled
} from '@/lib/db/recall-actions'
import { backfillUser } from '@/lib/memory/recall-backfill'

/**
 * Get whether conversation recall is enabled for the current user (default on).
 */
export async function getRecallEnabled(): Promise<boolean> {
  const userId = await getCurrentUserId()
  if (!userId) return true
  return isRecallEnabled(userId)
}

/**
 * Enable or disable conversation recall for the current user.
 */
export async function setRecallEnabledAction(on: boolean) {
  const userId = await getCurrentUserId()
  if (!userId) return { success: false, error: 'User not authenticated' }
  await setRecallEnabled(userId, on)
  return { success: true }
}

/** Real row counts — the settings panel shows these, never a guess. */
export async function getRecallStatus(): Promise<{
  chunks: number
  chats: number
}> {
  const userId = await getCurrentUserId()
  if (!userId) return { chunks: 0, chats: 0 }
  return countChunks(userId)
}

/**
 * Index one bounded slice of the user's un-indexed messages.
 *
 * A full rebuild can take minutes at scale — far too long to await inside a
 * single server action without risking a proxy/action timeout that would
 * surface "Rebuild failed" while indexing actually kept going server-side.
 * Instead this indexes a small, bounded batch and returns; the client loops,
 * calling this repeatedly and re-reading the real chunk count each round.
 * This is safe because `messagesWithoutChunks` (via `backfillUser`) always
 * skips messages that already have chunks, so repeated calls are idempotent
 * and each one makes real, visible progress. `done: true` once a call finds
 * nothing left to index (messages === 0).
 */
export async function rebuildRecallIndexAction() {
  const userId = await getCurrentUserId()
  if (!userId) return { success: false, error: 'User not authenticated' }
  const { messages, chunks } = await backfillUser(userId, {
    batchSize: 25,
    maxBatches: 4
  })
  return { success: true, messages, chunks, done: messages === 0 }
}

/**
 * Delete every indexed chunk for the current user.
 */
export async function clearRecallIndexAction() {
  const userId = await getCurrentUserId()
  if (!userId) return { success: false, error: 'User not authenticated' }
  await clearChunks(userId)
  return { success: true }
}
