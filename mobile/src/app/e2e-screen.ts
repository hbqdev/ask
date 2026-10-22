// Simulator E2E only: a screen seeded in Capacitor Preferences before launch
// is opened once the app is signed in, so a screenshot run needs no taps (it
// cannot tap over SSH). The run writes `CapacitorStorage.e2e-screen` (e.g.
// 'library') into the app container's
// `Library/Preferences/win.hbqnexus.ask.plist`
// (`xcrun simctl get_app_container <udid> win.hbqnexus.ask data`) while the
// app is terminated. Never use `simctl spawn … defaults write`: cfprefsd
// caching made a seeded question run twice (duplicate lab chats).
// A default or device build never reads the key.
import { useEffect, useRef } from 'react'

import { useSelectTab, type TabId } from '@/app/Tabs'
import {
  preferencesStorage,
  type AuthStorage
} from '@/core/auth/preferences-storage'
import { isE2eAutoSend } from '@/core/config'
import { useStack, type ScreenEntry } from '@/core/nav/stack'
import { openMemory } from '@/features/settings/MemoryScreen'
import { openPrivacy } from '@/features/settings/PrivacyScreen'

/** The Preferences key that holds the seeded screen. */
export const E2E_SCREEN_KEY = 'e2e-screen'

/** What the app can do to reach a seeded screen. */
export type E2eNav = {
  selectTab(id: TabId): void
  push(screen: ScreenEntry): void
}

/**
 * Each screen a run can seed, and how to open it. A screen whose page does
 * not exist yet maps to null (accepted, but opens nothing); a task that adds
 * the page replaces its null with the way there.
 */
const E2E_SCREENS = {
  ask: nav => nav.selectTab('ask'),
  discover: nav => nav.selectTab('discover'),
  library: nav => nav.selectTab('library'),
  settings: nav => nav.selectTab('settings'),
  'settings/memory': nav => {
    nav.selectTab('settings')
    openMemory(nav.push)
  },
  'settings/privacy': nav => {
    nav.selectTab('settings')
    openPrivacy(nav.push)
  }
} satisfies Record<string, ((nav: E2eNav) => void) | null>

export type E2eScreen = keyof typeof E2E_SCREENS

/** The seeded screen, or null when the value names none. */
export function parseE2eScreen(value: string): E2eScreen | null {
  const screen = value.trim()
  return Object.hasOwn(E2E_SCREENS, screen) ? (screen as E2eScreen) : null
}

/**
 * Opens the screen seeded under E2E_SCREEN_KEY, once per launch. Mount it
 * inside the signed-in tab shell (it switches tabs with useSelectTab and
 * pushes with useStack).
 */
export function useE2eScreen({
  enabled = isE2eAutoSend(),
  storage = preferencesStorage
}: {
  /** On only in a VITE_E2E_AUTOSEND build. */
  enabled?: boolean
  storage?: AuthStorage
} = {}) {
  const selectTab = useSelectTab()
  const { push } = useStack()
  // Set before the run below starts (effects run in order).
  const nav = useRef<E2eNav | null>(null)
  useEffect(() => {
    nav.current = { selectTab: id => selectTab?.(id), push }
  }, [selectTab, push])

  // Once per launch, even across StrictMode's double effects.
  const started = useRef(false)
  useEffect(() => {
    if (!enabled || started.current) return
    started.current = true
    const run = async () => {
      const value = await storage.getItem(E2E_SCREEN_KEY)
      if (value === null) return
      // Removed first, so a relaunch never opens it a second time.
      await storage.removeItem(E2E_SCREEN_KEY)
      const screen = parseE2eScreen(value)
      if (screen) E2E_SCREENS[screen]?.(nav.current!)
    }
    run().catch(err => {
      console.warn('[e2e] could not open the seeded screen', err)
    })
  }, [enabled, storage])
}
