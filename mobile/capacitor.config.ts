import type { CapacitorConfig } from '@capacitor/cli'
import { KeyboardResize } from '@capacitor/keyboard'

// The app is bundled: Vite builds src/ into dist/, and Capacitor ships dist/
// inside the app. It talks to Ask's backend over fetch with a bearer token,
// so there is no server.url, no cookie store and no in-app OAuth web view.

// No backgroundColor anywhere: Capacitor would paint the web view, and the
// SplashScreen plugin the launch storyboard's view, with that one colour in
// BOTH appearances. Unset, the web view keeps systemBackground and the splash
// keeps its adaptive LaunchBackground behind the SplashMark (light #fcfcfc,
// dark #030309, the page background), and MainViewController colours the
// safe-area strips the same way (src/launch-colours.test.ts checks them all).

const config: CapacitorConfig = {
  appId: 'win.hbqnexus.ask',
  appName: 'Ask',
  webDir: 'dist',
  ios: {
    // The native view controller pins the web view to the safe area, so the
    // page itself must not add its own insets on top of that.
    contentInset: 'never',
    scrollEnabled: true,
    allowsLinkPreview: false
  },
  plugins: {
    SplashScreen: {
      // The app hides the splash itself (src/app/splash.ts) once the theme
      // and the session are known, with a 2.5 s fallback, so launch never
      // shows a blank frame or the wrong theme. The duration only applies if
      // auto-hide is ever turned back on.
      launchShowDuration: 600,
      launchAutoHide: false,
      launchFadeOutDuration: 200,
      showSpinner: false
    },
    Keyboard: {
      // The web view shrinks above the keyboard, so the thread's composer is
      // never covered by it.
      resize: KeyboardResize.Native,
      resizeOnFullScreen: true
    }
  }
}

export default config
