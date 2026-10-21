import type { CapacitorConfig } from '@capacitor/cli'

// The app is bundled: Vite builds src/ into dist/, and Capacitor ships dist/
// inside the app. It talks to Ask's backend over fetch with a bearer token,
// so there is no server.url, no cookie store and no in-app OAuth web view.

// Ask's dark --background (oklch(0.1 0.022 289)), used behind the safe areas
// so the status-bar and home-indicator strips match the app.
const BACKGROUND = '#0c0a14'

const config: CapacitorConfig = {
  appId: 'win.hbqnexus.ask',
  appName: 'Ask',
  webDir: 'dist',
  backgroundColor: BACKGROUND,
  ios: {
    // The native view controller pins the web view to the safe area, so the
    // page itself must not add its own insets on top of that.
    contentInset: 'never',
    backgroundColor: BACKGROUND,
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
      backgroundColor: BACKGROUND,
      showSpinner: false
    }
  }
}

export default config
