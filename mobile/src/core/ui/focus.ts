// Focus for modal layers (sheets, the image viewer): focus goes back to
// whatever had it when the layer opened, and Tab stays inside the layer.

import { useEffect, useState } from 'react'

/**
 * On unmount, give focus back to the element that had it when the calling
 * component first rendered (before anything inside it could take focus),
 * without scrolling the page to it.
 */
export function useReturnFocus(): void {
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => () => opener?.focus({ preventScroll: true }), [opener])
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Keep a Tab keydown inside `container`: forward from the last focusable
 * wraps to the first, Shift+Tab from the first to the last, and from the
 * container itself Tab enters at the first (Shift+Tab at the last). Other
 * keys pass through untouched.
 */
export function trapTab(e: KeyboardEvent, container: HTMLElement): void {
  if (e.key !== 'Tab') return
  e.preventDefault()
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
  if (items.length === 0) {
    container.focus()
    return
  }
  const at = items.indexOf(document.activeElement as HTMLElement)
  const step = e.shiftKey ? -1 : 1
  const next =
    at === -1
      ? e.shiftKey
        ? items.length - 1
        : 0
      : (at + step + items.length) % items.length
  items[next].focus()
}
