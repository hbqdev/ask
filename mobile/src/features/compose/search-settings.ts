// The search settings each turn sends (mode and sources), kept across
// launches in Capacitor Preferences. A stored value is checked with the same
// rules the chat route applies to a request body, so the app never sends
// settings the server would discard.

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  preferencesStorage,
  type AuthStorage
} from '@/core/auth/preferences-storage'
import type { SearchSettings } from '@/features/thread/chat-body'
import { resolveSearchSettings } from '@/lib/utils/request-search-settings'

/** The Preferences key that holds the settings, as JSON. */
export const SEARCH_SETTINGS_KEY = 'ask-search-settings'

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  searchMode: 'balanced',
  sources: ['web']
}

/**
 * A stored value as settings. A missing, unparseable or invalid field falls
 * back to its default (balanced; web), as on the server.
 */
export function parseSearchSettings(value: string | null): SearchSettings {
  let stored: unknown
  try {
    stored = value === null ? null : JSON.parse(value)
  } catch {
    stored = null
  }
  const fields =
    typeof stored === 'object' && stored !== null
      ? (stored as Record<string, unknown>)
      : {}
  // With no cookie values, the server's fallbacks are the defaults above.
  return resolveSearchSettings({
    bodySearchMode: fields.searchMode,
    bodySources: fields.sources
  })
}

export async function loadSearchSettings(
  storage: AuthStorage = preferencesStorage
): Promise<SearchSettings> {
  return parseSearchSettings(await storage.getItem(SEARCH_SETTINGS_KEY))
}

export async function saveSearchSettings(
  settings: SearchSettings,
  storage: AuthStorage = preferencesStorage
): Promise<void> {
  await storage.setItem(SEARCH_SETTINGS_KEY, JSON.stringify(settings))
}

/**
 * The settings and a setter. It starts on the defaults and moves to the
 * stored settings once they load; a change shows at once and is saved in the
 * background (a failed save only costs the change at the next launch).
 */
export function useSearchSettings(
  storage: AuthStorage = preferencesStorage
): [SearchSettings, (settings: SearchSettings) => void] {
  const [settings, setSettings] = useState(DEFAULT_SEARCH_SETTINGS)
  // Set once the user changes something, so a slow load cannot undo it.
  const changed = useRef(false)

  useEffect(() => {
    loadSearchSettings(storage)
      .then(stored => {
        if (!changed.current) setSettings(stored)
      })
      // Unreadable storage leaves the defaults.
      .catch(() => {})
  }, [storage])

  const update = useCallback(
    (next: SearchSettings) => {
      changed.current = true
      setSettings(next)
      saveSearchSettings(next, storage).catch(error => {
        console.warn('Could not save the search settings', error)
      })
    },
    [storage]
  )

  return [settings, update]
}
