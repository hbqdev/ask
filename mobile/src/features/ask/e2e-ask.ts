// Simulator E2E only: a question seeded in Capacitor Preferences before
// launch is asked once the app is signed in and its settings have loaded.
// (`simctl openurl` with the ask:// scheme stops at iOS's "Open in Ask?"
// prompt, which cannot be tapped over SSH.) The run writes
// `CapacitorStorage.e2e-ask` (the question) into the app container's
// `Library/Preferences/win.hbqnexus.ask.plist`
// (`xcrun simctl get_app_container <udid> win.hbqnexus.ask data`) while the
// app is terminated. Never use `simctl spawn … defaults write`: cfprefsd
// caching made a seeded question run twice (duplicate lab chats).
// A default or device build never reads the key.
import { useEffect, useRef } from 'react'

import {
  preferencesStorage,
  type AuthStorage
} from '@/core/auth/preferences-storage'
import { isE2eAutoSend } from '@/core/config'

/** The Preferences key that holds the seeded question. */
export const E2E_ASK_KEY = 'e2e-ask'

export function useE2eAsk(
  onQuestion: (question: string) => void,
  {
    enabled = isE2eAutoSend(),
    ready,
    storage = preferencesStorage
  }: {
    /** On only in a VITE_E2E_AUTOSEND build. */
    enabled?: boolean
    /** Signed in with the search settings loaded. */
    ready: boolean
    storage?: AuthStorage
  }
) {
  const latest = useRef(onQuestion)
  useEffect(() => {
    latest.current = onQuestion
  }, [onQuestion])

  // Once per launch, even across StrictMode's double effects.
  const started = useRef(false)
  useEffect(() => {
    if (!enabled || !ready || started.current) return
    started.current = true
    const run = async () => {
      const question = (await storage.getItem(E2E_ASK_KEY))?.trim()
      if (!question) return
      // Removed first, so a relaunch can never ask it a second time.
      await storage.removeItem(E2E_ASK_KEY)
      latest.current(question)
    }
    run().catch(err => {
      console.warn('[e2e] could not read the seeded question', err)
    })
  }, [enabled, ready, storage])
}
