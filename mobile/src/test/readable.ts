// On an iPad a screen's content sits in a readable column (READABLE,
// core/ui/classes): centred, at most 720 px wide. Its scroller, pull area,
// header hairlines and the tab bar stay the full width of the screen. jsdom
// has no layout, so these read the column's classes.

import { expect } from 'vitest'

const COLUMN = ['mx-auto', 'w-full', 'max-w-[720px]']

/** Whether `el` itself is a readable column. */
export function isReadableColumn(el: Element): boolean {
  return COLUMN.every(c => el.classList.contains(c))
}

/** The readable column `el` sits in (itself included), or null. */
export function readableColumn(el: Element): Element | null {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (isReadableColumn(node)) return node
  }
  return null
}

/**
 * Asserts `el` sits in a readable column inside its screen's scroller
 * (`data-scroll-root`), while the scroller itself spans the screen.
 */
export function expectReadableInScroller(el: Element) {
  const column = readableColumn(el)
  expect(column, 'a readable column').not.toBeNull()
  const scroller = el.closest('[data-scroll-root]')
  expect(scroller, 'a scroller').not.toBeNull()
  expect(scroller!.contains(column)).toBe(true)
  expect(scroller).not.toBe(column)
  expect(readableColumn(scroller!), 'the scroller is full width').toBeNull()
}
