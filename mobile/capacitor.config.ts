import type { CapacitorConfig } from '@capacitor/cli'
import { KeyboardResize } from '@capacitor/keyboard'

// The app is bundled: Vite builds src/ into dist/, and Capacitor ships dist/
// inside the app. It talks to Ask's backend over fetch with a bearer token,
// so there is no server.url, no cookie store and no in-app OAuth web view.

// No backgroundColor anywhere: Capacitor would paint the web view, and the
// SplashScreen plugin the launch storyboard's view, with that one colour in
// BOTH appearances. Unset, the web view keeps systemBackground and the splash
// keeps its adaptive LaunchBackground behind the SplashMark (light #fcfcfc,
// dark #030309, the page background), and MainViewController colours its
// container (seen behind the keyboard) the same way (src/launch-colours.test.ts
// checks them all).

const config: CapacitorConfig = {
  appId: 'win.hbqnexus.ask',
  appName: 'Ask',
  webDir: 'dist',
  ios: {
    // The web view runs edge to edge (MainViewController) and the page pads
    // itself with env(safe-area-inset-*) (src/styles.css); 'never' keeps
    // WKWebView from insetting its scroll view as well, which would add the
    // insets twice.
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
      // No plugin resize: MainViewController ends the web view at the
      // keyboard's top itself (following the keyboard's frame, and again on
      // a resize or rotation), so the composer sits just above it. A second
      // writer on the same frame would fight it. The plugin's keyboard events
      // still fire; nothing in the app listens to them.
      resize: KeyboardResize.None
    }
  }
}

export default config
