// A tap on the status bar scrolls the screen in front to the top, as in any
// iOS app. Native (MainViewController) turns the tap into a `statusTap`
// window event; screens mark their main scroller with `data-scroll-root`, and
// so does a sheet, whose list takes the tap while it is open.

import { useEffect } from 'react'

/** Whether nothing around `el` hides it: no inert, hidden or inline
 *  visibility: hidden ancestor (an inactive tab, a hidden Library segment). */
export function isShown(el: HTMLElement): boolean {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (
      node.hasAttribute('inert') ||
      node.hasAttribute('hidden') ||
      node.style.visibility === 'hidden'
    ) {
      return false
    }
  }
  return true
}

/** Whether `el` scrolls vertically (overflow-y auto or scroll). */
function scrollsY(el: HTMLElement): boolean {
  const { overflowY } = getComputedStyle(el)
  return overflowY === 'auto' || overflowY === 'scroll'
}

/**
 * The scroller a status-bar tap moves: with a modal open (a sheet), the
 * top-most modal's own list, its first shown `[data-scroll-root]`, else its
 * first vertically scrollable element; never the screen behind it. The image
 * viewer has nothing to go to the top of. With no modal, the first shown
 * `[data-scroll-root]` in the top stack layer (not one sliding out).
 */
function frontScroller(root: ParentNode): HTMLElement | undefined {
  const modals = root.querySelectorAll<HTMLElement>('[aria-modal="true"]')
  const modal = modals[modals.length - 1]
  if (modal) {
    if (modal.classList.contains('image-viewer')) return undefined
    const marked = [
      ...modal.querySelectorAll<HTMLElement>('[data-scroll-root]')
    ].find(isShown)
    return (
      marked ??
      [...modal.querySelectorAll<HTMLElement>('*')].find(
        el => scrollsY(el) && isShown(el)
      )
    )
  }
  const layers = root.querySelectorAll<HTMLElement>(
    '.stack-layer:not(.stack-leave)'
  )
  const layer = layers[layers.length - 1]
  if (!layer) return undefined
  return [...layer.querySelectorAll<HTMLElement>('[data-scroll-root]')].find(
    isShown
  )
}

/**
 * Scrolls the front scroller to the top (see frontScroller): smooth, or a
 * jump under reduced motion. False when there is nothing to scroll.
 */
export function scrollActiveToTop(root: ParentNode = document): boolean {
  const scroller = frontScroller(root)
  if (!scroller) return false
  // A web view without matchMedia counts as motion allowed.
  const reduce =
    window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
  scroller.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
  return true
}

/** Scrolls the front screen to the top on each status-bar tap. */
export function useStatusTap(): void {
  useEffect(() => {
    const onTap = () => {
      scrollActiveToTop()
    }
    window.addEventListener('statusTap', onTap)
    return () => window.removeEventListener('statusTap', onTap)
  }, [])
}
