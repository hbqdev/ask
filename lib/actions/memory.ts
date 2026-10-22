'use server'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import {
  clearMemories,
  deleteMemory,
  isMemoryEnabled,
  listMemories,
  setMemoryEnabled
} from '@/lib/db/memory-actions'
import type { MemoryListItem } from '@/lib/db/schema'

/**
 * Get all memories for the current user (without their embeddings).
 */
export async function getMemories(): Promise<MemoryListItem[]> {
  const userId = await getCurrentUserId()
  if (!userId) {
    return []
  }
  return listMemories(userId)
}

/**
 * Get whether memory is enabled for the current user (default on).
 */
export async function getMemoryEnabled(): Promise<boolean> {
  const userId = await getCurrentUserId()
  if (!userId) {
    return true
  }
  return isMemoryEnabled(userId)
}

/**
 * Delete a single memory belonging to the current user. `deleted` is false
 * when no such memory exists (missing, or someone else's); that still counts
 * as success, since the memory is gone either way.
 */
export async function deleteMemoryAction(id: string) {
  const userId = await getCurrentUserId()
  if (!userId) {
    return { success: false, error: 'User not authenticated' }
  }

  const deleted = await deleteMemory(userId, id)
  return { success: true, deleted }
}

/**
 * Clear all memories for the current user.
 */
export async function clearMemoriesAction() {
  const userId = await getCurrentUserId()
  if (!userId) {
    return { success: false, error: 'User not authenticated' }
  }

  await clearMemories(userId)
  return { success: true }
}

/**
 * Enable or disable memory for the current user.
 */
export async function setMemoryEnabledAction(on: boolean) {
  const userId = await getCurrentUserId()
  if (!userId) {
    return { success: false, error: 'User not authenticated' }
  }

  await setMemoryEnabled(userId, on)
  return { success: true }
}
