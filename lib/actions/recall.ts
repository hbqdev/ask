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
 * Repeated calls are idempotent because `messagesWithoutChunks` (via
 * `backfillUser`) always re-selects messages that still lack chunks. That
 * cuts both ways: `indexMessage` never throws (see recall-index.ts) — on a
 * failure (e.g. the embedding model hasn't downloaded yet, or an
 * EMBEDDING_MODEL dimension mismatch) it swallows the error and returns 0
 * chunks WITHOUT indexing, so a round can report `messages > 0` with
 * `chunks === 0`: work was attempted but no progress was made, and the same
 * messages would be re-selected forever. This action does not claim `done`
 * in that case — `done: true` only fires once a call finds nothing left to
 * index at all (messages === 0 AND that emptiness is genuine, see `ok`
 * below) — so the caller (the client loop) is responsible for treating a
 * `messages > 0 && chunks === 0` round as a hard failure and stopping
 * rather than looping forever.
 *
 * `backfillUser` returns `ok: false` both when recall is disabled (a
 * rebuild can never work) and when the batch loop caught a real DB error —
 * either way, `messages === 0` there means "nothing was indexed AND we
 * don't actually know the index is up to date", not success. Reporting
 * `done: true` for that would show a green "Index is already up to date"
 * toast while nothing was verified, so this action surfaces `success: false`
 * instead, matching the honesty the rest of this feature depends on: every
 * control must do what it appears to do.
 */
export async function rebuildRecallIndexAction() {
  const userId = await getCurrentUserId()
  if (!userId) return { success: false, error: 'User not authenticated' }
  const { messages, chunks, ok } = await backfillUser(userId, {
    batchSize: 25,
    maxBatches: 4
  })
  if (!ok) {
    return {
      success: false,
      error: 'Rebuild failed — see server logs'
    }
  }
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
