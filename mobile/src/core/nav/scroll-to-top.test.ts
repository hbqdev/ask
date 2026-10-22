import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { scrollActiveToTop, useStatusTap } from '@/core/nav/scroll-to-top'

// The shape StackView and Tabs render: stack layers, the top one last, a tab
// panel per opened tab (inactive ones inert and visibility: hidden), and
// screens' scrollers marked data-scroll-root.
function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.append(root)
  for (const el of root.querySelectorAll<HTMLElement>('[data-scroll-root]')) {
    el.scrollTo = vi.fn() as unknown as HTMLElement['scrollTo']
  }
  return root
}

const byId = (root: ParentNode, id: string) =>
  root.querySelector<HTMLElement>(`#${id}`)!

function reducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduce && query === '(prefers-reduced-motion: reduce)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  )
}

beforeEach(() => reducedMotion(false))

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('scrollActiveToTop', () => {
  it('scrolls the top layer’s visible scroller', () => {
    const root = mount(`
      <div class="stack-layer" inert>
        <div id="below" data-scroll-root></div>
      </div>
      <div class="stack-layer">
        <header>Title</header>
        <div id="thread" data-scroll-root></div>
      </div>`)
    expect(scrollActiveToTop(root)).toBe(true)
    expect(byId(root, 'thread').scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: 'smooth'
    })
    expect(byId(root, 'below').scrollTo).not.toHaveBeenCalled()
  })

  it('skips an inert tab panel and a visibility:hidden Library segment', () => {
    const root = mount(`
      <div class="stack-layer">
        <div role="tabpanel" style="visibility: hidden" inert>
          <div id="discover" data-scroll-root></div>
        </div>
        <div role="tabpanel">
          <div style="visibility: hidden" inert>
            <div id="chats" data-scroll-root></div>
          </div>
          <div style="visibility: hidden">
            <div id="hidden-only" data-scroll-root></div>
          </div>
          <div hidden>
            <div id="hidden-attr" data-scroll-root></div>
          </div>
          <div>
            <div id="notes" data-scroll-root></div>
          </div>
        </div>
      </div>`)
    expect(scrollActiveToTop(root)).toBe(true)
    expect(byId(root, 'notes').scrollTo).toHaveBeenCalledTimes(1)
    for (const id of ['discover', 'chats', 'hidden-only', 'hidden-attr']) {
      expect(byId(root, id).scrollTo).not.toHaveBeenCalled()
    }
  })

  it('ignores a .stack-leave layer', () => {
    const root = mount(`
      <div class="stack-layer">
        <div id="library" data-scroll-root></div>
      </div>
      <div class="stack-layer stack-leave" inert>
        <div id="popped" data-scroll-root></div>
      </div>`)
    expect(scrollActiveToTop(root)).toBe(true)
    expect(byId(root, 'library').scrollTo).toHaveBeenCalledTimes(1)
    expect(byId(root, 'popped').scrollTo).not.toHaveBeenCalled()
  })

  it('jumps (auto) under reduced motion', () => {
    reducedMotion(true)
    const root = mount(`
      <div class="stack-layer"><div id="list" data-scroll-root></div></div>`)
    scrollActiveToTop(root)
    expect(byId(root, 'list').scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: 'auto'
    })
  })

  it('returns false with no scroller', () => {
    expect(scrollActiveToTop(mount(`<div class="stack-layer"></div>`))).toBe(
      false
    )
    expect(
      scrollActiveToTop(
        mount(`
          <div class="stack-layer">
            <div inert><div data-scroll-root></div></div>
          </div>`)
      )
    ).toBe(false)
    // No stack at all (signed out).
    expect(scrollActiveToTop(mount(`<main data-scroll-root></main>`))).toBe(
      false
    )
  })

  it('looks in the whole document by default', () => {
    const root = mount(`
      <div class="stack-layer"><div id="list" data-scroll-root></div></div>`)
    expect(scrollActiveToTop()).toBe(true)
    expect(byId(root, 'list').scrollTo).toHaveBeenCalledTimes(1)
  })
})

describe('useStatusTap', () => {
  it('scrolls the active screen to the top on each status-bar tap, until unmounted', () => {
    const root = mount(`
      <div class="stack-layer"><div id="list" data-scroll-root></div></div>`)
    const list = byId(root, 'list')
    const { unmount } = renderHook(() => useStatusTap())
    window.dispatchEvent(new Event('statusTap'))
    window.dispatchEvent(new Event('statusTap'))
    expect(list.scrollTo).toHaveBeenCalledTimes(2)
    unmount()
    window.dispatchEvent(new Event('statusTap'))
    expect(list.scrollTo).toHaveBeenCalledTimes(2)
  })
})
