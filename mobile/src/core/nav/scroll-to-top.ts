// A tap on the status bar scrolls the screen in front to the top, as in any
// iOS app. Native (MainViewController) turns the tap into a `statusTap`
// window event; screens mark their main scroller with `data-scroll-root`.

import { useEffect } from 'react'

/** Whether nothing around `el` hides it: no inert, hidden or inline
 *  visibility: hidden ancestor (an inactive tab, a hidden Library segment). */
function isShown(el: HTMLElement): boolean {
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

/**
 * Scrolls the front screen's scroller to the top: the first shown
 * `[data-scroll-root]` in the top stack layer (not one sliding out). Smooth,
 * or a jump under reduced motion. False when there is nothing to scroll.
 */
export function scrollActiveToTop(root: ParentNode = document): boolean {
  const layers = root.querySelectorAll<HTMLElement>(
    '.stack-layer:not(.stack-leave)'
  )
  const layer = layers[layers.length - 1]
  if (!layer) return false
  const scroller = [
    ...layer.querySelectorAll<HTMLElement>('[data-scroll-root]')
  ].find(isShown)
  if (!scroller) return false
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
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
