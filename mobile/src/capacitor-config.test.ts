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

  it('resizes the native web view for the keyboard, also in full screen', () => {
    // The composer sits at the bottom of the thread: with a native resize the
    // web view shrinks above the keyboard instead of being covered by it.
    expect(config.plugins?.Keyboard).toEqual({
      resize: 'native',
      resizeOnFullScreen: true
    })
  })
})
