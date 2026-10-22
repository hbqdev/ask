// Dynamic Type: the page's root font size follows the iOS text size
// (Settings > Display & Brightness > Text Size, and the larger accessibility
// sizes). WebKit exposes the user's body size as the system font
// `-apple-system-body`; a hidden probe set in it is measured, and the root
// moves by the same ratio, so all rem type scales. Spacing does not: the
// stylesheet fixes Tailwind's step at 4px (`--spacing` in src/styles.css).

/** The page's root font size at the iOS default (Large) text size. */
export const ROOT_DEFAULT_PX = 16
/** iOS body text at the default (Large) text size. */
export const BODY_DEFAULT_PX = 17
/** The smallest root: below it text stops being legible. */
export const ROOT_MIN_PX = 14
/** The largest root: past it the app's single-column layout breaks. */
export const ROOT_MAX_PX = 24

/** The root font size for this iOS body size, clamped and rounded to 0.01px. */
export function rootFontSize(systemBodyPx: number): number {
  if (!Number.isFinite(systemBodyPx) || systemBodyPx <= 0) {
    return ROOT_DEFAULT_PX
  }
  const scaled = (ROOT_DEFAULT_PX * systemBodyPx) / BODY_DEFAULT_PX
  const clamped = Math.min(ROOT_MAX_PX, Math.max(ROOT_MIN_PX, scaled))
  return Math.round(clamped * 100) / 100
}

/**
 * Keeps the root font size on the iOS text size: now, when the probe's size
 * changes (the setting changed while the app ran), and when the app comes
 * back into view. A no-op where the system body font is not known (any
 * browser but WebKit on Apple platforms). Returns the cleanup.
 */
export function watchTextSize(doc: Document = document): () => void {
  if (
    typeof CSS === 'undefined' ||
    !CSS.supports('font', '-apple-system-body')
  ) {
    return () => {}
  }

  const probe = doc.createElement('span')
  probe.setAttribute('aria-hidden', 'true')
  // As an attribute, so the system font reaches WebKit verbatim.
  probe.setAttribute(
    'style',
    'position:absolute; visibility:hidden; font:-apple-system-body'
  )
  probe.textContent = 'M'
  doc.body.appendChild(probe)

  const view = doc.defaultView ?? window
  const apply = () => {
    const body = parseFloat(view.getComputedStyle(probe).fontSize)
    doc.documentElement.style.fontSize = `${rootFontSize(body)}px`
  }
  apply()

  const observer = new ResizeObserver(apply)
  observer.observe(probe)
  doc.addEventListener('visibilitychange', apply)

  return () => {
    observer.disconnect()
    doc.removeEventListener('visibilitychange', apply)
    probe.remove()
  }
}
