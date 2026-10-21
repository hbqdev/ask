import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EDGE_ZONE } from '@/core/nav/use-edge-swipe'
import { ACTION_WIDTH, SwipeRow, type SwipeAction } from '@/core/ui/SwipeRow'

const WIDTH = 375

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(WIDTH)
})

afterEach(() => {
  vi.restoreAllMocks()
})

type Point = { x: number; y?: number; id?: number }

function at({ x, y = 100, id = 1 }: Point) {
  return { clientX: x, clientY: y, pointerId: id, isPrimary: true }
}

/** A drag on the row content along the points: down at the first, up at the last. */
function drag(content: HTMLElement, points: Point[]) {
  fireEvent.pointerDown(content, at(points[0]))
  for (const p of points.slice(1)) fireEvent.pointerMove(content, at(p))
  fireEvent.pointerUp(content, at(points[points.length - 1]))
}

/** A tap: a press and release in place, then the click it makes. */
function tap(content: HTMLElement, x = 200) {
  fireEvent.pointerDown(content, at({ x }))
  fireEvent.pointerUp(content, at({ x }))
  fireEvent.click(content)
}

function makeActions() {
  const del = vi.fn()
  const rename = vi.fn()
  const actions: SwipeAction[] = [
    { label: 'Delete', tone: 'destructive', onAction: del },
    { label: 'Rename', onAction: rename }
  ]
  return { del, rename, actions }
}

function setup(title = 'Chat A') {
  const onPress = vi.fn()
  const { del, rename, actions } = makeActions()
  render(
    <SwipeRow actions={actions} onPress={onPress}>
      <span>{title}</span>
    </SwipeRow>
  )
  return { onPress, del, rename, content: content(title) }
}

const content = (title: string) => screen.getByRole('button', { name: title })
const actionsOf = (title: string) =>
  content(title).parentElement!.querySelector('[data-swipe-actions]')!
const isOpen = (title: string) => !actionsOf(title).hasAttribute('inert')
const OPEN = `translate3d(-${2 * ACTION_WIDTH}px, 0, 0)`

describe('SwipeRow', () => {
  it('starts closed with its actions inert', () => {
    const { content } = setup()
    expect(isOpen('Chat A')).toBe(false)
    expect(content.style.transform).toBe('')
  })

  it('follows a left drag with a transform only', () => {
    const { content } = setup()
    fireEvent.pointerDown(content, at({ x: 300 }))
    fireEvent.pointerMove(content, at({ x: 270 }))
    expect(content.style.transform).toBe('translate3d(-30px, 0, 0)')
    expect(content.style.transition).toBe('none')
  })

  it('snaps open after a 100 px left drag, revealing the actions', () => {
    const { content } = setup()
    drag(content, [{ x: 300 }, { x: 250 }, { x: 200 }])
    expect(isOpen('Chat A')).toBe(true)
    expect(content.style.transform).toBe(OPEN)
    expect(content.style.transition).toBe('')
  })

  it('snaps back closed after a 40 px drag', () => {
    const { content } = setup()
    drag(content, [{ x: 300 }, { x: 260 }])
    expect(isOpen('Chat A')).toBe(false)
    expect(content.style.transform).toBe('')
  })

  it('does not engage on a vertical drag', () => {
    const { content, onPress } = setup()
    drag(content, [
      { x: 300, y: 100 },
      { x: 290, y: 160 },
      { x: 150, y: 170 }
    ])
    expect(isOpen('Chat A')).toBe(false)
    expect(content.style.transform).toBe('')
    expect(onPress).not.toHaveBeenCalled()
  })

  it('does not engage on a right drag while closed', () => {
    const { content } = setup()
    drag(content, [{ x: 100 }, { x: 150 }, { x: 250 }])
    expect(isOpen('Chat A')).toBe(false)
    expect(content.style.transform).toBe('')
  })

  it('ignores a drag that starts in the stack’s back-swipe edge zone', () => {
    const { content } = setup()
    drag(content, [{ x: EDGE_ZONE }, { x: EDGE_ZONE - 20 }])
    fireEvent.pointerDown(content, at({ x: EDGE_ZONE - 4 }))
    fireEvent.pointerMove(content, at({ x: 0 }))
    expect(content.style.transform).toBe('')
  })

  it('never moves right of its resting place', () => {
    const { content } = setup()
    fireEvent.pointerDown(content, at({ x: 300 }))
    fireEvent.pointerMove(content, at({ x: 280 }))
    fireEvent.pointerMove(content, at({ x: 340 }))
    expect(content.style.transform).toBe('translate3d(0px, 0, 0)')
  })

  it('triggers the first action on a full swipe past 60% of the width, and closes', () => {
    const { content, del, rename } = setup()
    drag(content, [{ x: 340 }, { x: 200 }, { x: 340 - 0.6 * WIDTH - 1 }])
    expect(del).toHaveBeenCalledTimes(1)
    expect(rename).not.toHaveBeenCalled()
    expect(isOpen('Chat A')).toBe(false)
    expect(content.style.transform).toBe('')
  })

  it('only opens (no action) at exactly 60% of the width', () => {
    const { content, del } = setup()
    drag(content, [{ x: 340 }, { x: 340 - 0.6 * WIDTH }])
    expect(del).not.toHaveBeenCalled()
    expect(isOpen('Chat A')).toBe(true)
  })

  it('clamps the drag at the row width', () => {
    const { content } = setup()
    fireEvent.pointerDown(content, at({ x: 370 }))
    fireEvent.pointerMove(content, at({ x: 360 }))
    fireEvent.pointerMove(content, at({ x: -200 }))
    expect(content.style.transform).toBe(`translate3d(-${WIDTH}px, 0, 0)`)
  })

  it('never full-swipes when the width is unknown', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(0)
    const { content, del } = setup()
    drag(content, [{ x: 340 }, { x: 330 }, { x: 0 }])
    expect(del).not.toHaveBeenCalled()
    expect(isOpen('Chat A')).toBe(true)
  })

  it('calls onPress on a tap when closed', () => {
    const { content, onPress } = setup()
    tap(content)
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('calls onPress on Enter or Space from the keyboard', () => {
    const { content, onPress } = setup()
    fireEvent.keyDown(content, { key: 'Enter' })
    fireEvent.keyDown(content, { key: ' ' })
    fireEvent.keyDown(content, { key: 'a' })
    expect(onPress).toHaveBeenCalledTimes(2)
  })

  it('closes instead of pressing on a tap while open', () => {
    const { content, onPress } = setup()
    drag(content, [{ x: 300 }, { x: 200 }])
    tap(content)
    expect(onPress).not.toHaveBeenCalled()
    expect(isOpen('Chat A')).toBe(false)
    tap(content)
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('swallows the click that ends a swipe', () => {
    const { content, onPress } = setup()
    drag(content, [{ x: 300 }, { x: 260 }])
    fireEvent.click(content)
    expect(onPress).not.toHaveBeenCalled()
    tap(content)
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('presses from the keyboard even right after a swipe', () => {
    const { content, onPress } = setup()
    drag(content, [{ x: 300 }, { x: 260 }])
    fireEvent.keyDown(content, { key: 'Enter' })
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('closes from the keyboard while open', () => {
    const { content, onPress } = setup()
    drag(content, [{ x: 300 }, { x: 200 }])
    fireEvent.keyDown(content, { key: 'Enter' })
    expect(onPress).not.toHaveBeenCalled()
    expect(isOpen('Chat A')).toBe(false)
  })

  it('runs an action from its button and closes', () => {
    const { content, rename, del } = setup()
    drag(content, [{ x: 300 }, { x: 200 }])
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(rename).toHaveBeenCalledTimes(1)
    expect(del).not.toHaveBeenCalled()
    expect(isOpen('Chat A')).toBe(false)
  })

  it('closes after a right drag on an open row', () => {
    const { content } = setup()
    drag(content, [{ x: 300 }, { x: 200 }])
    drag(content, [{ x: 200 }, { x: 230 }, { x: 300 }])
    expect(isOpen('Chat A')).toBe(false)
    expect(content.style.transform).toBe('')
  })

  it('stays open after a short right drag on an open row', () => {
    const { content } = setup()
    drag(content, [{ x: 300 }, { x: 200 }])
    drag(content, [{ x: 200 }, { x: 220 }])
    expect(isOpen('Chat A')).toBe(true)
    expect(content.style.transform).toBe(OPEN)
  })

  it('a tap that closes an open row is swallowed', () => {
    const pressA = vi.fn()
    const pressB = vi.fn()
    const { actions } = makeActions()
    render(
      <>
        <SwipeRow actions={actions} onPress={pressA}>
          <span>Chat A</span>
        </SwipeRow>
        <SwipeRow actions={actions} onPress={pressB}>
          <span>Chat B</span>
        </SwipeRow>
      </>
    )
    drag(content('Chat A'), [{ x: 300 }, { x: 200 }])
    tap(content('Chat B'))
    expect(isOpen('Chat A')).toBe(false)
    expect(pressB).not.toHaveBeenCalled()
    tap(content('Chat B'))
    expect(pressB).toHaveBeenCalledTimes(1)
    expect(pressA).not.toHaveBeenCalled()
  })

  it('swallows the closing tap on anything else too (a header button)', () => {
    const onHeader = vi.fn()
    const { content } = setup()
    render(
      <button type="button" onClick={onHeader}>
        Edit
      </button>
    )
    const header = screen.getByRole('button', { name: 'Edit' })
    drag(content, [{ x: 300 }, { x: 200 }])
    fireEvent.pointerDown(header)
    fireEvent.pointerUp(header)
    expect(fireEvent.click(header)).toBe(false)
    expect(onHeader).not.toHaveBeenCalled()
    expect(isOpen('Chat A')).toBe(false)
    fireEvent.pointerDown(header)
    fireEvent.click(header)
    expect(onHeader).toHaveBeenCalledTimes(1)
  })

  it('swallows nothing later when the closing press made no click (a scroll)', () => {
    const { content, onPress } = setup()
    drag(content, [{ x: 300 }, { x: 200 }])
    fireEvent.pointerDown(document.body)
    fireEvent.pointerCancel(document.body)
    expect(isOpen('Chat A')).toBe(false)
    tap(content)
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('swallows nothing when no row was open', () => {
    const { content, onPress } = setup()
    fireEvent.pointerDown(document.body)
    tap(content)
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('closes on a tap elsewhere, but not on a press inside itself', () => {
    const { content } = setup()
    drag(content, [{ x: 300 }, { x: 200 }])
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Delete' }))
    expect(isOpen('Chat A')).toBe(true)
    fireEvent.pointerDown(document.body)
    expect(isOpen('Chat A')).toBe(false)
  })

  it('keeps only one row open: opening another closes the first', () => {
    const onPress = vi.fn()
    const { actions } = makeActions()
    render(
      <>
        <SwipeRow actions={actions} onPress={onPress}>
          <span>Chat A</span>
        </SwipeRow>
        <SwipeRow actions={actions} onPress={onPress}>
          <span>Chat B</span>
        </SwipeRow>
      </>
    )
    drag(content('Chat A'), [{ x: 300 }, { x: 200 }])
    expect(isOpen('Chat A')).toBe(true)
    drag(content('Chat B'), [{ x: 300 }, { x: 200 }])
    expect(isOpen('Chat B')).toBe(true)
    expect(isOpen('Chat A')).toBe(false)
    expect(content('Chat A').style.transform).toBe('')
  })

  it('settles back where it was when the drag is cancelled', () => {
    const { content } = setup()
    fireEvent.pointerDown(content, at({ x: 300 }))
    fireEvent.pointerMove(content, at({ x: 150 }))
    fireEvent.pointerCancel(content, at({ x: 150 }))
    fireEvent.pointerUp(content, at({ x: 150 }))
    expect(isOpen('Chat A')).toBe(false)
    expect(content.style.transform).toBe('')
  })

  it('drops a press cancelled before it became a swipe (the browser took a scroll)', () => {
    const { content } = setup()
    fireEvent.pointerDown(content, at({ x: 300 }))
    fireEvent.pointerCancel(content, at({ x: 300 }))
    fireEvent.pointerMove(content, at({ x: 100 }))
    expect(content.style.transform).toBe('')
  })

  it('settles back open when a drag on an open row is cancelled', () => {
    const { content } = setup()
    drag(content, [{ x: 300 }, { x: 200 }])
    fireEvent.pointerDown(content, at({ x: 200 }))
    fireEvent.pointerMove(content, at({ x: 280 }))
    fireEvent.pointerCancel(content, at({ x: 280 }))
    expect(isOpen('Chat A')).toBe(true)
    expect(content.style.transform).toBe(OPEN)
  })

  it('ignores moves and releases from another pointer or without a press', () => {
    const { content } = setup()
    fireEvent.pointerMove(content, at({ x: 100 }))
    fireEvent.pointerUp(content, at({ x: 100 }))
    fireEvent.pointerCancel(content, at({ x: 100 }))
    fireEvent.pointerDown(content, at({ x: 300 }))
    fireEvent.pointerMove(content, at({ x: 100, id: 2 }))
    fireEvent.pointerUp(content, at({ x: 100, id: 2 }))
    fireEvent.pointerCancel(content, at({ x: 100, id: 2 }))
    expect(content.style.transform).toBe('')
    expect(isOpen('Chat A')).toBe(false)
  })

  it('ignores a press from a non-primary pointer', () => {
    const { content } = setup()
    fireEvent.pointerDown(content, { ...at({ x: 300 }), isPrimary: false })
    fireEvent.pointerMove(content, at({ x: 100 }))
    expect(content.style.transform).toBe('')
  })

  it('leaves the registry clean when an open row unmounts', () => {
    const onPress = vi.fn()
    const { actions } = makeActions()
    const view = render(
      <SwipeRow actions={actions} onPress={onPress}>
        <span>Chat A</span>
      </SwipeRow>
    )
    drag(content('Chat A'), [{ x: 300 }, { x: 200 }])
    view.unmount()
    // A new row opening must not try to close the unmounted one.
    setup('Chat C')
    drag(content('Chat C'), [{ x: 300 }, { x: 200 }])
    expect(isOpen('Chat C')).toBe(true)
  })

  it('styles a destructive action apart from a plain one', () => {
    setup()
    const del = screen.getByRole('button', { name: 'Delete' })
    const rename = screen.getByRole('button', { name: 'Rename' })
    expect(del.className).toContain('bg-red-500')
    expect(rename.className).not.toContain('bg-red-500')
  })
})
