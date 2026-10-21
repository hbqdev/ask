// A launch-timing mark: one console line when the app's first real screen
// (sign-in or the tab shell) is ready and the native splash is about to hide.
// Capacitor forwards console.log to the app's stdout in Debug builds, so
// `xcrun simctl launch --stdout=<file>` can time cold launches against it
// (sync-mac.sh `launch-times`). The line carries no user data.

/** The token the launch-timing script looks for. */
export const FIRST_RENDER_MARK = 'ASK_FIRST_RENDER'

let marked = false

/**
 * Logs `ASK_FIRST_RENDER <performance.now() ms> <Date.now() epoch ms>`,
 * once per page load. The epoch lets a timer outside the web view (the
 * simulator shares the Mac's clock) measure from process launch.
 */
export function markFirstRender(
  now: () => number = () => performance.now(),
  wall: () => number = () => Date.now()
): void {
  if (marked) return
  marked = true
  console.log(`${FIRST_RENDER_MARK} ${now().toFixed(1)} ${wall()}`)
}

/** Forgets that the mark was logged. Tests only. */
export function resetFirstRenderMarkForTests(): void {
  marked = false
}
