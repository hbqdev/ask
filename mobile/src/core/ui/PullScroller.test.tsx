import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { PullScroller } from '@/core/ui/PullScroller'

vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))

const touch = (y: number) => ({ identifier: 0, clientX: 100, clientY: y })

function drag(el: HTMLElement, ys: number[]) {
  fireEvent.touchStart(el, {
    touches: [touch(100)],
    changedTouches: [touch(100)]
  })
  for (const y of ys) {
    fireEvent.touchMove(el, { touches: [touch(y)], changedTouches: [touch(y)] })
  }
}

const release = (el: HTMLElement, y: number) =>
  fireEvent.touchEnd(el, { touches: [], changedTouches: [touch(y)] })

const listRenders = vi.fn()
function List() {
  listRenders()
  return <p>The list</p>
}

function Screen({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const scroller = useRef<HTMLDivElement>(null)
  return (
    <PullScroller scroller={scroller} onRefresh={onRefresh} testId="feed">
      <List />
    </PullScroller>
  )
}

const scroll = () => screen.getByTestId('feed-scroll')
const content = () => screen.getByTestId('feed-content')

describe('PullScroller', () => {
  it('scrolls its children, at rest, with the test ids it is given', () => {
    render(<Screen onRefresh={vi.fn(async () => {})} />)
    expect(scroll()).toContainElement(content())
    // A status-bar tap scrolls it to the top (core/nav/scroll-to-top).
    expect(scroll()).toHaveAttribute('data-scroll-root')
    expect(content()).toHaveTextContent('The list')
    expect(content().style.transform).toBe('')
    expect(content()).toHaveClass('pull-settle')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('moves the children under the finger, without re-rendering them', () => {
    render(<Screen onRefresh={vi.fn(async () => {})} />)
    listRenders.mockClear()
    drag(scroll(), [130, 200, 260])
    expect(content().style.transform).toMatch(/^translate3d\(0, [\d.]+px, 0\)$/)
    expect(content()).not.toHaveClass('pull-settle')
    expect(listRenders).not.toHaveBeenCalled()
  })

  it('refreshes when released far enough, spinning until it settles', async () => {
    let done!: () => void
    const onRefresh = vi.fn(() => new Promise<void>(r => (done = r)))
    render(<Screen onRefresh={onRefresh} />)
    drag(scroll(), [200, 400])
    release(scroll(), 400)
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(screen.getByRole('status', { name: 'Refreshing' })).toBeVisible()
    expect(content()).toHaveClass('pull-settle')
    expect(content().style.transform).not.toBe('')

    await act(async () => done())
    expect(screen.queryByRole('status')).toBeNull()
    expect(content().style.transform).toBe('')
  })

  it('goes back to rest, without refreshing, when released short', () => {
    const onRefresh = vi.fn(async () => {})
    render(<Screen onRefresh={onRefresh} />)
    drag(scroll(), [115, 130])
    expect(content().style.transform).not.toBe('')
    release(scroll(), 130)
    expect(onRefresh).not.toHaveBeenCalled()
    expect(content().style.transform).toBe('')
    expect(content()).toHaveClass('pull-settle')
  })
})
