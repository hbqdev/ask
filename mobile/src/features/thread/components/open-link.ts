// Every external link the thread shows opens here: in the in-app browser
// (SFSafariViewController on iOS), never by navigating the app's web view.
// Only an absolute http(s) URL is ever opened; anything else (javascript:,
// data:, file:, a custom scheme, a relative path) is refused silently, so no
// caller can open one by mistake. A relative upload must be resolved against
// the API base by its caller first.
import { Browser } from '@capacitor/browser'

/** Whether `url` is an absolute http(s) URL. */
export function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Open a URL in the in-app browser, or do nothing for one that is not
 * http(s). A failure to present it leaves the user where they were, with
 * nothing they could retry differently, so it is handled here rather than
 * surfacing as an unhandled rejection.
 */
export function openLink(url: string): void {
  if (!isHttpUrl(url)) return
  Browser.open({ url }).catch(() => {})
}
