// One set of search settings for the whole signed-in app: the home composer
// and every thread's composer read and change the same state, so a mode picked
// on one shows on all (useSearchSettings alone is per caller).

import { createContext, useContext, useMemo, type ReactNode } from 'react'

import {
  preferencesStorage,
  type AuthStorage
} from '@/core/auth/preferences-storage'
import { useSearchSettings } from '@/features/compose/search-settings'
import type { SearchSettings } from '@/features/thread/chat-body'

/** The settings, their setter, and whether the stored ones have loaded. */
type SharedSearchSettings = [
  SearchSettings,
  (settings: SearchSettings) => void,
  boolean
]

const SearchSettingsContext = createContext<SharedSearchSettings | null>(null)

export function SearchSettingsProvider({
  storage = preferencesStorage,
  children
}: {
  /** Where the settings are kept: Capacitor Preferences unless a test says. */
  storage?: AuthStorage
  children: ReactNode
}) {
  const [settings, setSettings, loaded] = useSearchSettings(storage)
  const value = useMemo<SharedSearchSettings>(
    () => [settings, setSettings, loaded],
    [settings, setSettings, loaded]
  )
  return (
    <SearchSettingsContext.Provider value={value}>
      {children}
    </SearchSettingsContext.Provider>
  )
}

/** The app's search settings and their setter (see SearchSettingsProvider). */
export function useSharedSearchSettings(): SharedSearchSettings {
  const shared = useContext(SearchSettingsContext)
  if (!shared) {
    throw new Error(
      'useSharedSearchSettings must be used inside a SearchSettingsProvider'
    )
  }
  return shared
}
