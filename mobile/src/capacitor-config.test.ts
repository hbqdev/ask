import { describe, expect, it } from 'vitest'

import config from '../capacitor.config'

describe('capacitor.config', () => {
  it('holds the native splash until the app hides it', () => {
    // useHideSplash (src/app/splash.ts) hides it once the theme and the
    // session are known, so launch never shows a blank or wrong-theme frame.
    expect(config.plugins?.SplashScreen).toMatchObject({
      launchAutoHide: false,
      showSpinner: false
    })
  })

  it('leaves the web view’s size to the native shell', () => {
    // MainViewController ends the web view at the keyboard's top (the
    // composer sits just above it); the plugin's own resize would be a second
    // writer on the same frame, so it is off. Its keyboard events still fire.
    expect(config.plugins?.Keyboard).toEqual({ resize: 'none' })
  })
})
