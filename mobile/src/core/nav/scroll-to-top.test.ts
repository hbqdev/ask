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

  it('with a sheet open, scrolls the sheet’s own list, not the screen behind', () => {
    const root = mount(`
      <div class="stack-layer">
        <div id="thread" data-scroll-root></div>
      </div>
      <div class="fixed">
        <div role="dialog" aria-modal="true">
          <h2>Sources</h2>
          <div id="sheet-list" data-scroll-root></div>
        </div>
      </div>`)
    expect(scrollActiveToTop(root)).toBe(true)
    expect(byId(root, 'sheet-list').scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: 'smooth'
    })
    expect(byId(root, 'thread').scrollTo).not.toHaveBeenCalled()
  })

  it('scrolls the top-most of two open sheets', () => {
    const root = mount(`
      <div class="stack-layer"><div id="thread" data-scroll-root></div></div>
      <div role="dialog" aria-modal="true">
        <div id="under" data-scroll-root></div>
      </div>
      <div role="dialog" aria-modal="true">
        <div id="over" data-scroll-root></div>
      </div>`)
    expect(scrollActiveToTop(root)).toBe(true)
    expect(byId(root, 'over').scrollTo).toHaveBeenCalledTimes(1)
    expect(byId(root, 'under').scrollTo).not.toHaveBeenCalled()
    expect(byId(root, 'thread').scrollTo).not.toHaveBeenCalled()
  })

  it('with a modal that has no marked list, scrolls its first scrollable element', () => {
    const root = mount(`
      <div class="stack-layer"><div id="thread" data-scroll-root></div></div>
      <div role="dialog" aria-modal="true">
        <div id="plain"></div>
        <div id="list" style="overflow-y: auto"></div>
      </div>`)
    const list = byId(root, 'list')
    list.scrollTo = vi.fn() as unknown as HTMLElement['scrollTo']
    const plain = byId(root, 'plain')
    plain.scrollTo = vi.fn() as unknown as HTMLElement['scrollTo']
    expect(scrollActiveToTop(root)).toBe(true)
    expect(list.scrollTo).toHaveBeenCalledTimes(1)
    expect(plain.scrollTo).not.toHaveBeenCalled()
    expect(byId(root, 'thread').scrollTo).not.toHaveBeenCalled()
  })

  it('with the image viewer open, scrolls nothing', () => {
    const root = mount(`
      <div class="stack-layer"><div id="thread" data-scroll-root></div></div>
      <div role="dialog" aria-modal="true" class="image-viewer">
        <div id="strip" style="overflow-x: auto; overflow-y: auto"></div>
      </div>`)
    const strip = byId(root, 'strip')
    strip.scrollTo = vi.fn() as unknown as HTMLElement['scrollTo']
    expect(scrollActiveToTop(root)).toBe(false)
    expect(strip.scrollTo).not.toHaveBeenCalled()
    expect(byId(root, 'thread').scrollTo).not.toHaveBeenCalled()
  })

  it('with a modal that has nothing to scroll, leaves the screen behind alone', () => {
    const root = mount(`
      <div class="stack-layer"><div id="thread" data-scroll-root></div></div>
      <div role="dialog" aria-modal="true"><p>Delete this chat?</p></div>`)
    expect(scrollActiveToTop(root)).toBe(false)
    expect(byId(root, 'thread').scrollTo).not.toHaveBeenCalled()
  })

  it('treats a web view without matchMedia as motion allowed', () => {
    vi.stubGlobal('matchMedia', undefined)
    const root = mount(`
      <div class="stack-layer"><div id="list" data-scroll-root></div></div>`)
    expect(scrollActiveToTop(root)).toBe(true)
    expect(byId(root, 'list').scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: 'smooth'
    })
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
