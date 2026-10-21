// The Library's sort order, kept across launches in Capacitor Preferences.

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  preferencesStorage,
  type AuthStorage
} from '@/core/auth/preferences-storage'
import type { ChatSort } from '@/features/library/library-api'

/** The Preferences key that holds the sort, as its plain name. */
export const LIBRARY_SORT_KEY = 'ask-library-sort'

/** The sorts, in the order the sort menu lists them. */
export const LIBRARY_SORTS: { value: ChatSort; label: string }[] = [
  { value: 'recent', label: 'Recent' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'title', label: 'Title' }
]

/** A stored value as a sort; anything else is `recent`, the default. */
export function parseLibrarySort(value: string | null): ChatSort {
  return LIBRARY_SORTS.find(s => s.value === value)?.value ?? 'recent'
}

/**
 * The sort, a setter, and whether it has loaded. It starts on `recent` and
 * moves to the stored sort once that loads (or stays on `recent` when storage
 * cannot be read). A change shows at once and is saved in the background; a
 * failed save only costs the change at the next launch.
 */
export function useLibrarySort(
  storage: AuthStorage = preferencesStorage
): [ChatSort, (sort: ChatSort) => void, boolean] {
  const [sort, setSortState] = useState<ChatSort>('recent')
  const [loaded, setLoaded] = useState(false)
  // Set once the user picks a sort, so a slow load cannot undo it.
  const changed = useRef(false)

  useEffect(() => {
    storage
      .getItem(LIBRARY_SORT_KEY)
      .then(value => {
        if (!changed.current) setSortState(parseLibrarySort(value))
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [storage])

  const setSort = useCallback(
    (next: ChatSort) => {
      changed.current = true
      setSortState(next)
      storage.setItem(LIBRARY_SORT_KEY, next).catch(() => {})
    },
    [storage]
  )

  return [sort, setSort, loaded]
}
