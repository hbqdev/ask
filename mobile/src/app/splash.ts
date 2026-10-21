// The native launch screen stays up (capacitor.config.ts: launchAutoHide
// false) until the app can paint its real first screen in the right theme, so
// launch never shows a blank frame or a flash of the wrong theme.

import { Capacitor } from '@capacitor/core'
import { SplashScreen } from '@capacitor/splash-screen'
import { useEffect, useRef } from 'react'

/** Hide the splash after this long even if the app never becomes ready. */
export const SPLASH_FALLBACK_MS = 2500

/** Hides the native splash once `ready`, or after the fallback timeout. */
export function useHideSplash(ready: boolean): void {
  const hidden = useRef(false)

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    const hide = () => {
      if (hidden.current) return
      hidden.current = true
      // A splash that is already gone is fine.
      SplashScreen.hide().catch(() => {})
    }
    if (ready) {
      hide()
      return
    }
    const timer = setTimeout(hide, SPLASH_FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [ready])
}
