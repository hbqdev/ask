// The status bar's content colour. Native (MainViewController) picks light
// or dark content from the page background; a screen drawn over it in black,
// such as the image viewer, asks for light content while it is up. Requests
// are counted, so two viewers (or one closing as another opens) never clear
// each other's: while any is held, <html data-status-bar="light">, which the
// native theme script watches.

let held = 0

/** Light status-bar content until the returned release is called (once). */
export function requestLightStatusBar(): () => void {
  held += 1
  document.documentElement.dataset.statusBar = 'light'
  let released = false
  return () => {
    if (released) return
    released = true
    held -= 1
    if (held === 0) delete document.documentElement.dataset.statusBar
  }
}
