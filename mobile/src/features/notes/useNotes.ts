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
  getNotesCache,
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

  // Bumped by every first-page load: a page from an older one is dropped.
  const generation = useRef(0)
  // The generation of the next page now loading, if any.
  const loadingMoreIn = useRef<number | null>(null)
  // Notes removed here, kept out of any page that raced the delete.
  const removed = useRef(new Set<string>())

  const keep = useCallback(
    (notes: Note[]) => notes.filter(n => !removed.current.has(n.id)),
    []
  )

  const refresh = useCallback(async () => {
    const mine = ++generation.current
    // Signed out: nothing to show and nothing to ask the server for.
    if (!userId) {
      setView({ userId, status: 'ready' })
      return
    }
    const shown = getNotesCache()?.userId === userId
    setView(v => ({
      userId,
      status: shown ? 'refreshing' : 'loading',
      error: v.userId === userId ? v.error : undefined
    }))
    try {
      const page = await fetchNotesPage(client)
      if (mine !== generation.current) return
      setNotesCache({
        userId,
        notes: keep(page.notes),
        nextCursor: page.nextCursor
      })
      setView({ userId, status: 'ready' })
    } catch (error) {
      if (mine !== generation.current) return
      setView({ userId, ...failed(error) })
    }
  }, [client, userId, keep])

  // On mount and for a new user: load the first page.
  useEffect(() => {
    void refresh()
  }, [refresh])

  const loadMore = useCallback(async () => {
    const cursor = userId && cacheCursor(userId)
    const mine = generation.current
    if (!userId || !cursor || loadingMoreIn.current === mine) return
    loadingMoreIn.current = mine
    try {
      const page = await fetchNotesPage(client, { cursor })
      if (mine !== generation.current) return
      appendNotes(userId, keep(page.notes), page.nextCursor)
      setView({ userId, status: 'ready' })
    } catch (error) {
      if (mine !== generation.current) return
      setView({ userId, ...failed(error) })
    } finally {
      if (loadingMoreIn.current === mine) loadingMoreIn.current = null
    }
  }, [client, userId, keep])

  const remove = useCallback(
    async (id: string) => {
      if (!userId) return false
      const dropped = dropNote(userId, id)
      if (!dropped) return false
      removed.current.add(id)
      try {
        await deleteNote(client, id)
      } catch (error) {
        // Already gone on the server: that is what the user wanted.
        if (error instanceof ApiError && error.status === 404) return true
        removed.current.delete(id)
        restoreNote(userId, dropped)
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
 * the answer as saved (for the signed-in `userId`). Rejects when the save
 * fails, remembering nothing.
 */
export async function saveAnswerToNotes(
  client: ApiClient,
  userId: string | undefined,
  note: NewNote
): Promise<Note> {
  const saved = await saveNote(client, note)
  if (userId) addNote(userId, saved)
  return saved
}
