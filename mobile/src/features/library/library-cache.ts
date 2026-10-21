// The Library's first rows, kept in Capacitor Preferences so a launch shows
// the list at once (and offline) while it revalidates. The cache belongs to
// one user: it is stored with the user id and ignored for anyone else, and
// sign-out clears it.

import {
  preferencesStorage,
  type AuthStorage
} from '@/core/auth/preferences-storage'
import type { ChatRow, ChatSort } from '@/features/library/library-api'

/** The one Preferences key the Library cache uses. */
export const LIBRARY_CACHE_KEY = 'ask-library-cache'

/** Rows kept: two pages of 30. */
export const LIBRARY_CACHE_MAX_ROWS = 60

export type LibraryCache = { sort: ChatSort; chats: ChatRow[]; total?: number }

const SORTS: readonly ChatSort[] = ['recent', 'newest', 'oldest', 'title']

function isRow(value: unknown): value is ChatRow {
  const row = value as Partial<ChatRow> | null
  return (
    typeof row === 'object' &&
    row !== null &&
    typeof row.id === 'string' &&
    typeof row.title === 'string' &&
    typeof row.createdAt === 'string'
  )
}

/**
 * The cached rows for `userId`, or null when there are none, they belong to
 * another user, or what is stored cannot be read.
 */
export async function loadLibraryCache(
  userId: string,
  storage: AuthStorage = preferencesStorage
): Promise<LibraryCache | null> {
  let stored: Record<string, unknown> | null
  try {
    const raw = await storage.getItem(LIBRARY_CACHE_KEY)
    stored = raw === null ? null : JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof stored !== 'object' || stored === null) return null
  if (stored.userId !== userId) return null
  const sort = stored.sort as ChatSort
  if (!SORTS.includes(sort) || !Array.isArray(stored.chats)) return null
  const chats = stored.chats.filter(isRow)
  return typeof stored.total === 'number'
    ? { sort, chats, total: stored.total }
    : { sort, chats }
}

/** Saves the first rows for `userId`. Best-effort: it never rejects. */
export async function saveLibraryCache(
  userId: string,
  { sort, chats, total }: LibraryCache,
  storage: AuthStorage = preferencesStorage
): Promise<void> {
  const value = JSON.stringify({
    userId,
    sort,
    chats: chats.slice(0, LIBRARY_CACHE_MAX_ROWS),
    total,
    savedAt: new Date().toISOString()
  })
  try {
    await storage.setItem(LIBRARY_CACHE_KEY, value)
  } catch {
    // A failed save only costs the instant list at the next launch.
  }
}

/** Removes the cache (sign-out). */
export async function clearLibraryCache(
  storage: AuthStorage = preferencesStorage
): Promise<void> {
  await storage.removeItem(LIBRARY_CACHE_KEY)
}
