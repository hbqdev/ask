// The Library's segment (Chats or Notes), kept across launches in Capacitor
// Preferences: a device UI preference, kept on sign-out.

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  preferencesStorage,
  type AuthStorage
} from '@/core/auth/preferences-storage'

export type LibrarySegment = 'chats' | 'notes'

/** The Preferences key that holds the segment, as its plain name. */
export const LIBRARY_SEGMENT_KEY = 'ask-library-segment'

/** A stored value as a segment; anything else is `chats`, the default. */
export function parseLibrarySegment(value: string | null): LibrarySegment {
  return value === 'notes' ? 'notes' : 'chats'
}

/**
 * The segment, a setter, and whether it has loaded. It starts on `chats` and
 * moves to the stored segment once that loads (or stays on `chats` when
 * storage cannot be read). A change shows at once and is saved in the
 * background; a failed save only costs the change at the next launch.
 */
export function useLibrarySegment(
  storage: AuthStorage = preferencesStorage
): [LibrarySegment, (segment: LibrarySegment) => void, boolean] {
  const [segment, setSegmentState] = useState<LibrarySegment>('chats')
  const [loaded, setLoaded] = useState(false)
  // Set once the user picks a segment, so a slow load cannot undo it.
  const changed = useRef(false)

  useEffect(() => {
    storage
      .getItem(LIBRARY_SEGMENT_KEY)
      .then(value => {
        if (!changed.current) setSegmentState(parseLibrarySegment(value))
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [storage])

  const setSegment = useCallback(
    (next: LibrarySegment) => {
      changed.current = true
      setSegmentState(next)
      storage.setItem(LIBRARY_SEGMENT_KEY, next).catch(() => {})
    },
    [storage]
  )

  return [segment, setSegment, loaded]
}
