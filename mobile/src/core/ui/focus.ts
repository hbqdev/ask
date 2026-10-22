// Focus for modal layers (sheets, the image viewer): focus goes back to
// whatever had it when the layer opened, and Tab stays inside the layer.
// And for navigation: a screen shown by a push or a tab change takes focus
// at its title, so VoiceOver starts reading there.

import { useEffect, useState } from 'react'

import { isShown } from '@/core/nav/scroll-to-top'

/**
 * On unmount, give focus back to the element that had it when the calling
 * component first rendered (before anything inside it could take focus),
 * without scrolling the page to it. When that element is gone (a list row
 * windowed out or deleted) and focus went with the layer, the front screen's
 * title takes it, as on a pop (core/nav/stack).
 */
export function useReturnFocus(): void {
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(
    () => () => {
      if (!opener) return
      if (opener.isConnected) {
        opener.focus({ preventScroll: true })
        return
      }
      const active = document.activeElement
      if (active && active !== document.body) return
      const layers = document.querySelectorAll<HTMLElement>(
        '.stack-layer:not(.stack-leave)'
      )
      const top = layers[layers.length - 1]
      if (top) focusHeading(top)
    },
    [opener]
  )
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

/**
 * Focuses the first shown `h1` in `container` (a screen's title), without
 * scrolling. A heading is not focusable by itself, so one with no tabindex
 * gets -1 (focusable by script only; styles.css draws it no ring). False
 * when there is no shown h1.
 */
export function focusHeading(container: HTMLElement): boolean {
  const heading = [...container.querySelectorAll<HTMLElement>('h1')].find(
    isShown
  )
  if (!heading) return false
  if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1
  heading.focus({ preventScroll: true })
  return true
}

// Input types that are controls, not text: focusing one raises no keyboard.
const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit'
])

/**
 * Whether focusing `el` would raise the keyboard: a text field, a select, or
 * anything editable. Navigation never gives focus back to one of these.
 */
export function isTextEntry(el: Element): boolean {
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type)
  return el.matches(
    'textarea, select, [contenteditable]:not([contenteditable="false"]), [contenteditable]:not([contenteditable="false"]) *'
  )
}
