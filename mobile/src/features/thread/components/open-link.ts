// Every external link the thread shows opens here: in the in-app browser
// (SFSafariViewController on iOS), never by navigating the app's web view.
import { Browser } from '@capacitor/browser'

/**
 * Open a URL in the in-app browser. A failure to present it leaves the user
 * where they were, with nothing they could retry differently, so it is
 * handled here rather than surfacing as an unhandled rejection.
 */
export function openLink(url: string): void {
  Browser.open({ url }).catch(() => {})
}
