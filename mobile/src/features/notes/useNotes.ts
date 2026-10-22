// The Notes list's state: the signed-in user's notes, newest update first,
// paged by the server's keyset cursor. The rows live in the in-memory notes
// cache, so a revisit shows them at once while they revalidate, and a note
// saved or deleted on another screen shows here too. Delete is optimistic.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'

import { useApi } from '@/core/api/ApiProvider'
import type { ApiClient } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'
import { useAuth } from '@/core/auth/AuthProvider'
import {
  deleteNote,
  fetchNotesPage,
  isNotesUnavailable,
  NOTES_UNAVAILABLE,
  saveNote,
  type NewNote,
  type Note
} from '@/features/notes/notes-api'
import {
  addNote,
  appendNotes,
  dropNote,
  findNote,
  getNotesCache,
  getNotesEpoch,
  restoreNote,
  setNotesCache,
  subscribeNotesCache
} from '@/features/notes/notes-cache'

/** 'unavailable': the server keeps no notes (anonymous mode). */
export type NotesStatus =
  | 'loading'
  | 'ready'
  | 'refreshing'
  | 'error'
  | 'unavailable'

export type Notes = {
  notes: Note[]
  status: NotesStatus
  error?: string
  hasMore: boolean
  loadMore(): Promise<void>
  refresh(): Promise<void>
  /** Optimistic; puts the note back and sets `error` on failure. */
  remove(id: string): Promise<boolean>
}

/** The status and error of one user's list. */
type View = { userId?: string; status: NotesStatus; error?: string }

const NO_NOTES: Note[] = []

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** A failed load, as the list shows it. */
const failed = (error: unknown): Pick<View, 'status' | 'error'> =>
  isNotesUnavailable(error)
    ? { status: 'unavailable', error: NOTES_UNAVAILABLE }
    : { status: 'error', error: errorMessage(error) }

export function useNotes(): Notes {
  const { client } = useApi()
  const userId = useAuth().session?.user.id
  const cache = useSyncExternalStore(subscribeNotesCache, getNotesCache)
  const list = userId && cache?.userId === userId ? cache : null

  const [view, setView] = useState<View>(() => ({
    userId,
    status: list ? 'refreshing' : 'loading'
  }))

  // Bumped by every first-page load (and on unmount): a page from an older
  // one is dropped.
  const generation = useRef(0)
  // The generation whose first page the cached list is (or, after a failed
  // first page, that kept the list); -1 for none yet. A next page is read
  // only from that list's cursor while it is the current generation's.
  const committedIn = useRef(-1)
  // A next page asked for while the current first page is on its way. It
  // runs from the new list's cursor once that list is stored; a newer first
  // page, or a failed one, drops it.
  const moreWanted = useRef(false)
  // The generation of the next page now loading, if any.
  const loadingMoreIn = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    const mine = ++generation.current
    moreWanted.current = false
    // Signed out: nothing to show and nothing to ask the server for.
    if (!userId) {
      committedIn.current = mine
      setView({ userId, status: 'ready' })
      return
    }
    // A reset (sign-out) meanwhile: what lands belongs to nobody now.
    const epoch = getNotesEpoch()
    const shown = getNotesCache()?.userId === userId
    setView(v => ({
      userId,
      status: shown ? 'refreshing' : 'loading',
      error: v.userId === userId ? v.error : undefined
    }))
    try {
      const page = await fetchNotesPage(client)
      if (mine !== generation.current || epoch !== getNotesEpoch()) return
      setNotesCache({ userId, notes: page.notes, nextCursor: page.nextCursor })
      committedIn.current = mine
      setView({ userId, status: 'ready' })
    } catch (error) {
      if (mine !== generation.current) return
      // The list did not change: it stays, now as this generation's, and a
      // page wanted meanwhile is not loaded.
      committedIn.current = mine
      moreWanted.current = false
      setView({ userId, ...failed(error) })
    }
  }, [client, userId])

  // On mount and for a new user: load the first page. Unmounted, a page on
  // its way is dropped.
  useEffect(() => {
    void refresh()
    return () => {
      generation.current++
    }
  }, [refresh])

  const loadMore = useCallback(async () => {
    const mine = generation.current
    if (!userId) return
    if (committedIn.current !== mine) {
      moreWanted.current = true
      return
    }
    const cursor = cacheCursor(userId)
    if (!cursor || loadingMoreIn.current === mine) return
    loadingMoreIn.current = mine
    const epoch = getNotesEpoch()
    try {
      const page = await fetchNotesPage(client, { cursor })
      if (mine !== generation.current || epoch !== getNotesEpoch()) return
      appendNotes(userId, page.notes, page.nextCursor)
      setView({ userId, status: 'ready' })
    } catch (error) {
      if (mine !== generation.current) return
      setView({ userId, ...failed(error) })
    } finally {
      if (loadingMoreIn.current === mine) loadingMoreIn.current = null
    }
  }, [client, userId])

  // A next page wanted during a first-page load runs once that page is in.
  useEffect(() => {
    if (!moreWanted.current || committedIn.current !== generation.current) {
      return
    }
    moreWanted.current = false
    void loadMore()
  }, [view, loadMore])

  const remove = useCallback(
    async (id: string) => {
      if (!userId || !findNote(userId, id)) return false
      // Also kept out of any page that races the delete (notes-cache).
      const dropped = dropNote(userId, id)
      try {
        await deleteNote(client, id)
      } catch (error) {
        // Already gone on the server: that is what the user wanted.
        if (error instanceof ApiError && error.status === 404) return true
        restoreNote(userId, id, dropped)
        setView(v => ({ ...v, error: errorMessage(error) }))
        return false
      }
      return true
    },
    [client, userId]
  )

  // Another user's status is never shown, even for one render.
  const current: View =
    view.userId === userId
      ? view
      : { userId, status: list ? 'refreshing' : 'loading' }
  return {
    notes: list?.notes ?? NO_NOTES,
    status: current.status,
    error: current.error,
    hasMore: Boolean(list?.nextCursor),
    loadMore,
    refresh,
    remove
  }
}

/** The next page's cursor of `userId`'s cached list, if any. */
function cacheCursor(userId: string) {
  const cache = getNotesCache()
  return cache?.userId === userId ? cache.nextCursor : null
}

/**
 * Saves an answer as a note, puts it first in the Notes list and remembers
 * the answer as saved (for the signed-in `userId`, unless the cache was reset
 * meanwhile). Rejects when the save fails, remembering nothing.
 */
export async function saveAnswerToNotes(
  client: ApiClient,
  userId: string | undefined,
  note: NewNote
): Promise<Note> {
  const epoch = getNotesEpoch()
  const saved = await saveNote(client, note)
  // Signed out meanwhile: nothing of this account's is kept.
  if (userId && epoch === getNotesEpoch()) addNote(userId, saved)
  return saved
}
