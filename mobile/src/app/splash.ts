// The native launch screen stays up (capacitor.config.ts: launchAutoHide
// false) until the app can paint its real first screen in the right theme, so
// launch never shows a blank frame or a flash of the wrong theme. Because the
// app hides it, every way out must hide it: the app becoming ready
// (useHideSplash), an error boundary catching, and a failsafe timer armed in
// main.tsx before React renders at all.

import { Capacitor } from '@capacitor/core'
import { SplashScreen } from '@capacitor/splash-screen'
import { useEffect } from 'react'

import { markFirstRender } from '@/app/launchMark'

/** Hide the splash after this long even if the app never becomes ready. */
export const SPLASH_FALLBACK_MS = 2500

// One guard for every caller, so the splash is hidden once.
let hidden = false

/** Hides the native splash, once; a no-op on the web. */
export function hideSplash(): void {
  if (hidden || !Capacitor.isNativePlatform()) return
  hidden = true
  // A splash that is already gone is fine.
  SplashScreen.hide().catch(() => {})
}

/**
 * Hides the splash after `ms` whatever React does, so a crash during the
 * first render cannot leave the app stuck behind it. Call before rendering.
 */
export function armSplashFailsafe(ms: number = SPLASH_FALLBACK_MS): void {
  if (!Capacitor.isNativePlatform()) return
  setTimeout(hideSplash, ms)
}

/**
 * Hides the native splash once `ready`, or after the fallback timeout. Being
 * ready also logs the launch-timing mark (src/app/launchMark.ts); the
 * fallback does not, since nothing real is on screen then.
 */
export function useHideSplash(ready: boolean): void {
  useEffect(() => {
    if (ready) {
      markFirstRender()
      hideSplash()
      return
    }
    const timer = setTimeout(hideSplash, SPLASH_FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [ready])
}

/** Forgets that the splash was hidden. Tests only. */
export function resetSplashForTests(): void {
  hidden = false
}
