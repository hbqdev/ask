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
})
