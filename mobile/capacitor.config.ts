import type { CapacitorConfig } from '@capacitor/cli'

// The app is a native shell around the live site: the WKWebView loads
// ASK_URL directly, so every web deploy reaches the app with no rebuild.
// www/ only holds the page shown when the site can't be reached.
const ASK_URL = process.env.ASK_URL || 'https://ask.hbqnexus.win'

// Ask's dark --background (oklch(0.1 0.022 289)), used behind the safe areas
// so the status-bar and home-indicator strips match the app.
const BACKGROUND = '#0c0a14'

const config: CapacitorConfig = {
  appId: 'win.hbqnexus.ask',
  appName: 'Ask',
  webDir: 'www',
  backgroundColor: BACKGROUND,
  server: {
    url: ASK_URL,
    // Supabase auth calls and Google sign-in must stay inside the app; any
    // other host (a cited source, say) opens in Safari instead.
    allowNavigation: [
      'ask.hbqnexus.win',
      '*.supabase.co',
      'accounts.google.com',
      '*.google.com'
    ],
    errorPath: 'offline.html'
  },
  ios: {
    // The native view controller pins the web view to the safe area, so the
    // page itself must not add its own insets on top of that.
    contentInset: 'never',
    backgroundColor: BACKGROUND,
    scrollEnabled: true,
    allowsLinkPreview: false,
    // Google refuses OAuth inside embedded web views ("disallowed_useragent").
    // Presenting as mobile Safari lets "Sign in with Google" work in-app.
    overrideUserAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  },
  plugins: {
    // Routes document.cookie through the native cookie store. Safari caps
    // script-written cookies at 7 days, which is the likely cause of the
    // repeated logouts on the web; native cookies keep their own expiry.
    CapacitorCookies: { enabled: true },
    SplashScreen: {
      launchShowDuration: 600,
      launchAutoHide: true,
      backgroundColor: BACKGROUND,
      showSpinner: false
    }
  }
}

export default config
