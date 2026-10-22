import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { haptic } from '@/core/haptics'
import { EDGE_ZONE } from '@/core/nav/use-edge-swipe'
import {
  ACTION_WIDTH,
  LONG_PRESS_MS,
  OPEN_AT,
  SwipeRow,
  type SwipeAction
} from '@/core/ui/SwipeRow'

vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))

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

  it('swallows the closing click for 600 ms only (a later VoiceOver activation presses)', () => {
    vi.useFakeTimers()
    try {
      const { content, onPress } = setup()
      /** Opens the row, with the click that ends the swipe (dropped). */
      const open = () => {
        drag(content, [{ x: 300 }, { x: 200 }])
        fireEvent.click(content)
      }
      open()
      // Closed by a press that became a scroll: no click, no other press.
      fireEvent.pointerDown(document.body)
      vi.advanceTimersByTime(599)
      expect(fireEvent.click(document.body)).toBe(false)

      open()
      fireEvent.pointerDown(document.body)
      vi.advanceTimersByTime(600)
      // A screen reader activates with a click and no press.
      fireEvent.click(content)
      expect(onPress).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('swallows nothing after a key is pressed (a keyboard activation)', () => {
    const onHeader = vi.fn()
    const { content } = setup()
    render(
      <button type="button" onClick={onHeader}>
        Edit
      </button>
    )
    const header = screen.getByRole('button', { name: 'Edit' })
    drag(content, [{ x: 300 }, { x: 200 }])
    fireEvent.pointerDown(document.body)
    fireEvent.keyDown(header, { key: 'Enter' })
    fireEvent.click(header)
    expect(onHeader).toHaveBeenCalledTimes(1)
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
    expect(del.className).toContain('bg-red-600')
    expect(rename.className).not.toContain('bg-red-600')
  })
})

describe('SwipeRow colour', () => {
  const TRANSFORM = { propertyName: 'transform' }
  // The stylesheet's settle transition (styles.css, with motion allowed).
  let motion: HTMLStyleElement | undefined
  function withMotion() {
    motion = document.createElement('style')
    motion.textContent = '.swipe-row-content { transition-duration: 0.28s }'
    document.head.append(motion)
  }
  afterEach(() => motion?.remove())

  // The row's root, behind the content: past the buttons, a full swipe
  // shows the first action's colour there.
  const rootOf = (title: string) => content(title).parentElement!

  it('paints no action colour at rest', () => {
    setup()
    expect(rootOf('Chat A').className).not.toContain('bg-red-600')
    // Nor do the buttons behind the content: hidden, so none of their
    // colour shows at the edge of a rounded card's corner.
    expect(actionsOf('Chat A')).toHaveClass('invisible')
  })

  it('shows the buttons while swiping and while open, and hides them once closed', () => {
    const { content } = setup()
    fireEvent.pointerDown(content, at({ x: 300 }))
    fireEvent.pointerMove(content, at({ x: 270 }))
    expect(actionsOf('Chat A')).not.toHaveClass('invisible')
    fireEvent.pointerMove(content, at({ x: 200 }))
    fireEvent.pointerUp(content, at({ x: 200 }))
    expect(actionsOf('Chat A')).not.toHaveClass('invisible')
    tap(content)
    expect(actionsOf('Chat A')).toHaveClass('invisible')
  })

  it('paints it while swiping and while open', () => {
    const { content } = setup()
    fireEvent.pointerDown(content, at({ x: 300 }))
    fireEvent.pointerMove(content, at({ x: 270 }))
    expect(rootOf('Chat A')).toHaveClass('bg-red-600')
    fireEvent.pointerMove(content, at({ x: 200 }))
    fireEvent.pointerUp(content, at({ x: 200 }))
    expect(isOpen('Chat A')).toBe(true)
    expect(rootOf('Chat A')).toHaveClass('bg-red-600')
  })

  it('a press that has not moved paints nothing', () => {
    const { content } = setup()
    fireEvent.pointerDown(content, at({ x: 300 }))
    fireEvent.pointerMove(content, at({ x: 295 }))
    expect(rootOf('Chat A').className).not.toContain('bg-red-600')
  })

  it('clears it once closed', () => {
    const { content } = setup()
    drag(content, [{ x: 300 }, { x: 200 }])
    tap(content)
    expect(isOpen('Chat A')).toBe(false)
    expect(rootOf('Chat A').className).not.toContain('bg-red-600')
    // And after a swipe that snaps back closed.
    drag(content, [{ x: 300 }, { x: 260 }])
    expect(rootOf('Chat A').className).not.toContain('bg-red-600')
  })

  it('keeps it while the row slides closed, and clears it when the slide ends', () => {
    // With motion, closing slides the content back over the colour.
    withMotion()
    const { content } = setup()
    drag(content, [{ x: 300 }, { x: 200 }])
    tap(content)
    expect(rootOf('Chat A')).toHaveClass('bg-red-600')
    // A transition ending inside the content is not the row's own.
    fireEvent.transitionEnd(content.firstElementChild!, TRANSFORM)
    expect(rootOf('Chat A')).toHaveClass('bg-red-600')
    fireEvent.transitionEnd(content, TRANSFORM)
    expect(rootOf('Chat A').className).not.toContain('bg-red-600')
  })

  it('clears it when the slide closed is cut short (the row went out of view)', () => {
    withMotion()
    const { content } = setup()
    drag(content, [{ x: 300 }, { x: 200 }])
    tap(content)
    expect(rootOf('Chat A')).toHaveClass('bg-red-600')
    fireEvent.transitionCancel(content, TRANSFORM)
    expect(rootOf('Chat A').className).not.toContain('bg-red-600')
  })

  it('a transition of another property (a colour) does not clear it', () => {
    withMotion()
    const { content } = setup()
    drag(content, [{ x: 300 }, { x: 200 }])
    tap(content)
    fireEvent.transitionEnd(content, { propertyName: 'background-color' })
    expect(rootOf('Chat A')).toHaveClass('bg-red-600')
  })

  it('clears it once the slide’s time is up, should no transition event come', () => {
    vi.useFakeTimers()
    try {
      withMotion()
      const { content } = setup()
      drag(content, [{ x: 300 }, { x: 200 }])
      tap(content)
      vi.advanceTimersByTime(280)
      expect(rootOf('Chat A')).toHaveClass('bg-red-600')
      act(() => vi.advanceTimersByTime(60))
      expect(rootOf('Chat A').className).not.toContain('bg-red-600')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a swipe started before that time keeps it', () => {
    vi.useFakeTimers()
    try {
      withMotion()
      const { content } = setup()
      drag(content, [{ x: 300 }, { x: 200 }])
      tap(content)
      // Swiping again mid-slide: the row is exposed by the new swipe.
      fireEvent.pointerDown(content, at({ x: 300 }))
      fireEvent.pointerMove(content, at({ x: 270 }))
      act(() => vi.advanceTimersByTime(1000))
      expect(rootOf('Chat A')).toHaveClass('bg-red-600')
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears it on a row closed because another opened', () => {
    setup('Chat A')
    setup('Chat B')
    drag(content('Chat A'), [{ x: 300 }, { x: 200 }])
    expect(rootOf('Chat A')).toHaveClass('bg-red-600')
    drag(content('Chat B'), [{ x: 300 }, { x: 200 }])
    expect(isOpen('Chat A')).toBe(false)
    expect(rootOf('Chat A').className).not.toContain('bg-red-600')
    expect(rootOf('Chat B')).toHaveClass('bg-red-600')
  })

  it('keeps it when the slide that ends is an opening one', () => {
    withMotion()
    const { content } = setup()
    drag(content, [{ x: 300 }, { x: 200 }])
    fireEvent.transitionEnd(content, TRANSFORM)
    expect(rootOf('Chat A')).toHaveClass('bg-red-600')
  })

  it('clears it at once when a cancelled drag ends where it began (nothing to slide)', () => {
    withMotion()
    const { content } = setup()
    fireEvent.pointerDown(content, at({ x: 300 }))
    fireEvent.pointerMove(content, at({ x: 280 }))
    // Back to its start, then cancelled: no transform change, no slide.
    fireEvent.pointerMove(content, at({ x: 310 }))
    fireEvent.pointerCancel(content, at({ x: 310 }))
    expect(rootOf('Chat A').className).not.toContain('bg-red-600')
  })

  it('the content is the page colour by default, and the card tint on a card', () => {
    const { actions } = makeActions()
    render(
      <>
        <SwipeRow actions={actions} onPress={vi.fn()}>
          <span>On page</span>
        </SwipeRow>
        <SwipeRow actions={actions} onPress={vi.fn()} surface="card">
          <span>On card</span>
        </SwipeRow>
      </>
    )
    expect(content('On page')).toHaveClass('bg-background')
    expect(content('On page')).not.toHaveClass('bg-card')
    expect(content('On card')).toHaveClass('bg-card')
    expect(content('On card')).not.toHaveClass('bg-background')
    // Pressed: a step off its surface (in dark, muted is the card's own
    // colour, so a card row presses to the thumb).
    expect(content('On page')).toHaveClass('active:bg-muted')
    expect(content('On card')).toHaveClass(
      'active:bg-muted',
      'dark:active:bg-thumb'
    )
  })
})

describe('SwipeRow haptics', () => {
  beforeEach(() => vi.mocked(haptic).mockClear())

  const kinds = () => vi.mocked(haptic).mock.calls.map(([kind]) => kind)

  it('ticks selection once as a drag crosses the open threshold, however far it goes on', () => {
    const { content } = setup()
    fireEvent.pointerDown(content, at({ x: 300 }))
    fireEvent.pointerMove(content, at({ x: 300 - OPEN_AT }))
    expect(kinds()).toEqual([])
    fireEvent.pointerMove(content, at({ x: 300 - OPEN_AT - 1 }))
    fireEvent.pointerMove(content, at({ x: 180 }))
    fireEvent.pointerMove(content, at({ x: 150 }))
    fireEvent.pointerUp(content, at({ x: 150 }))
    expect(kinds()).toEqual(['selection'])
    expect(isOpen('Chat A')).toBe(true)
  })

  it('ticks again when the drag crosses back under the threshold', () => {
    const { content } = setup()
    drag(content, [{ x: 300 }, { x: 200 }, { x: 260 }, { x: 250 }])
    expect(kinds()).toEqual(['selection', 'selection'])
    expect(isOpen('Chat A')).toBe(false)
  })

  it('a drag short of the threshold, or a scroll, makes none', () => {
    const { content } = setup()
    drag(content, [{ x: 300 }, { x: 260 }])
    drag(content, [
      { x: 300, y: 100 },
      { x: 290, y: 160 },
      { x: 150, y: 170 }
    ])
    expect(kinds()).toEqual([])
  })

  it('an open row ticks once when dragged back under the threshold, not when dragged further open', () => {
    const { content } = setup()
    drag(content, [{ x: 300 }, { x: 200 }])
    vi.mocked(haptic).mockClear()
    drag(content, [{ x: 200 }, { x: 150 }])
    expect(kinds()).toEqual([])
    drag(content, [{ x: 100 }, { x: 200 }])
    expect(kinds()).toEqual(['selection'])
  })

  it('a full swipe running a destructive action taps light (the warning is its confirmation’s)', () => {
    const { content, del } = setup()
    drag(content, [{ x: 340 }, { x: 200 }, { x: 340 - 0.6 * WIDTH - 1 }])
    expect(del).toHaveBeenCalledTimes(1)
    expect(kinds()).toEqual(['selection', 'light'])
  })

  it('a full swipe running a plain action ends with a light tap', () => {
    const run = vi.fn()
    render(
      <SwipeRow
        actions={[{ label: 'Archive', onAction: run }]}
        onPress={vi.fn()}
      >
        <span>Chat B</span>
      </SwipeRow>
    )
    drag(content('Chat B'), [{ x: 340 }, { x: 200 }, { x: 100 }])
    expect(run).toHaveBeenCalledTimes(1)
    expect(kinds()).toEqual(['selection', 'light'])
  })

  it('tapping an action button taps light, Delete included', () => {
    const { del, rename } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(del).toHaveBeenCalledTimes(1)
    expect(kinds()).toEqual(['light'])
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(rename).toHaveBeenCalledTimes(1)
    expect(kinds()).toEqual(['light', 'light'])
  })

  it('a full swipe on a row with no actions runs nothing and closes', () => {
    render(
      <SwipeRow actions={[]} onPress={vi.fn()}>
        <span>Chat C</span>
      </SwipeRow>
    )
    drag(content('Chat C'), [{ x: 340 }, { x: 200 }, { x: 100 }])
    expect(content('Chat C').style.transform).toBe('')
    expect(kinds()).not.toContain('light')
    expect(kinds()).not.toContain('warning')
  })

  it('a tap on the row makes none', () => {
    const { content, onPress } = setup()
    tap(content)
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(kinds()).toEqual([])
  })
})

describe('SwipeRow long press', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(haptic).mockClear()
  })

  afterEach(() => {
    // Disarm a click swallow a test left armed, before the next test.
    act(() => vi.advanceTimersByTime(1000))
    vi.useRealTimers()
  })

  const sheet = () => screen.getByRole('dialog')
  const hold = (el: HTMLElement, ms = LONG_PRESS_MS, p: Point = { x: 200 }) => {
    fireEvent.pointerDown(el, at(p))
    act(() => vi.advanceTimersByTime(ms))
  }

  it('waits LONG_PRESS_MS, 500 ms', () => {
    expect(LONG_PRESS_MS).toBe(500)
  })

  it('a long press opens the actions sheet', () => {
    const { content } = setup()
    hold(content, LONG_PRESS_MS - 1)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => vi.advanceTimersByTime(1))

    expect(sheet()).toHaveAccessibleName('Actions')
    const buttons = within(sheet()).getAllByRole('button')
    expect(buttons.map(b => b.textContent)).toEqual([
      'Delete',
      'Rename',
      'Cancel'
    ])
    expect(buttons[0]).toHaveClass('text-destructive')
    expect(buttons[1]).not.toHaveClass('text-destructive')
    expect(haptic).toHaveBeenCalledExactlyOnceWith('medium')
    // The row itself stays at rest: no colour, buttons hidden and inert.
    expect(content.parentElement!.className).not.toContain('bg-red-600')
    expect(actionsOf('Chat A')).toHaveClass('invisible')
    expect(isOpen('Chat A')).toBe(false)
    expect(content.style.transform).toBe('')
  })

  it('titles the sheet with actionsTitle', () => {
    const { actions } = makeActions()
    render(
      <SwipeRow actions={actions} onPress={vi.fn()} actionsTitle="Trip notes">
        <span>Chat A</span>
      </SwipeRow>
    )
    hold(content('Chat A'))
    expect(sheet()).toHaveAccessibleName('Trip notes')
  })

  it('a small wobble still counts as holding still', () => {
    const { content } = setup()
    fireEvent.pointerDown(content, at({ x: 200, y: 100 }))
    fireEvent.pointerMove(content, at({ x: 206, y: 108 }))
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    expect(sheet()).toBeInTheDocument()
  })

  it('moving cancels the long press', () => {
    const { content } = setup()
    fireEvent.pointerDown(content, at({ x: 200, y: 100 }))
    fireEvent.pointerMove(content, at({ x: 200, y: 111 }))
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.pointerDown(content, at({ x: 200, y: 100 }))
    fireEvent.pointerMove(content, at({ x: 192, y: 93 }))
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(haptic).not.toHaveBeenCalledWith('medium')
  })

  it('another pointer’s move does not cancel it', () => {
    const { content } = setup()
    fireEvent.pointerDown(content, at({ x: 200 }))
    fireEvent.pointerMove(content, at({ x: 50, id: 2 }))
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    expect(sheet()).toBeInTheDocument()
  })

  it('a release or a cancel before 500 ms is no long press', () => {
    const { content, onPress } = setup()
    hold(content, 300)
    fireEvent.pointerUp(content, at({ x: 200 }))
    fireEvent.click(content)
    expect(onPress).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    expect(screen.queryByRole('dialog')).toBeNull()

    hold(content, 300)
    fireEvent.pointerCancel(content, at({ x: 200 }))
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a non-primary pointer starts none', () => {
    const { content } = setup()
    fireEvent.pointerDown(content, { ...at({ x: 200 }), isPrimary: false })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a press in the back-swipe edge zone is no long press (the edge is the stack’s)', () => {
    const { content } = setup()
    hold(content, LONG_PRESS_MS, { x: EDGE_ZONE })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('an open row’s press is no long press (a tap closes it)', () => {
    const { content } = setup()
    drag(content, [{ x: 300 }, { x: 200 }])
    expect(isOpen('Chat A')).toBe(true)
    hold(content)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('the long press’s click does not press the row', () => {
    const { content, onPress } = setup()
    hold(content)
    fireEvent.pointerUp(content, at({ x: 200 }))
    fireEvent.click(content)
    expect(onPress).not.toHaveBeenCalled()
    expect(sheet()).toBeInTheDocument()
  })

  it('nor closes the sheet, should it land on the backdrop', () => {
    const { content } = setup()
    hold(content)
    fireEvent.pointerUp(content, at({ x: 200 }))
    fireEvent.click(screen.getByTestId('sheet-backdrop'))
    expect(sheet()).toBeInTheDocument()
  })

  it('after the long press, the finger moving on does not swipe the row', () => {
    const { content } = setup()
    hold(content)
    fireEvent.pointerMove(content, at({ x: 100 }))
    fireEvent.pointerUp(content, at({ x: 100 }))
    expect(content.style.transform).toBe('')
    expect(isOpen('Chat A')).toBe(false)
  })

  it('choosing Delete runs the action, once the sheet has closed', () => {
    const { content, del } = setup()
    del.mockImplementation(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    hold(content)
    fireEvent.pointerUp(content, at({ x: 200 }))
    vi.mocked(haptic).mockClear()
    // The next press disarms the swallowed click; this one chooses.
    fireEvent.pointerDown(within(sheet()).getByText('Delete'))
    fireEvent.click(within(sheet()).getByText('Delete'))
    expect(del).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(haptic).toHaveBeenCalledExactlyOnceWith('light')
  })

  it('choosing an action gives focus back to the row before it runs', () => {
    const { content, rename } = setup()
    let focused: Element | null = null
    rename.mockImplementation(() => {
      focused = document.activeElement
    })
    content.focus()
    hold(content)
    fireEvent.click(within(sheet()).getByText('Rename'))
    expect(rename).toHaveBeenCalledTimes(1)
    expect(focused).toBe(content)
  })

  it('Cancel closes it and runs nothing', () => {
    const { content, del, rename } = setup()
    hold(content)
    fireEvent.click(within(sheet()).getByText('Cancel'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(del).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()
  })

  it('closes like any sheet (Escape, the backdrop), running nothing', () => {
    const { content, del, rename } = setup()
    hold(content)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.contextMenu(content)
    fireEvent.click(screen.getByTestId('sheet-backdrop'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(del).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()
  })

  it('a contextmenu event opens it too, with no browser menu', () => {
    const { content } = setup()
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true
    })
    act(() => {
      content.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(sheet()).toHaveAccessibleName('Actions')
    expect(haptic).toHaveBeenCalledExactlyOnceWith('medium')
  })

  it('a contextmenu that follows the long press opens nothing more', () => {
    const { content } = setup()
    hold(content)
    fireEvent.contextMenu(content)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(haptic).toHaveBeenCalledExactlyOnceWith('medium')
  })

  it('a contextmenu during a press (before 500 ms) swallows that press’s click', () => {
    const { content, onPress } = setup()
    hold(content, 300)
    fireEvent.contextMenu(content)
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    fireEvent.pointerUp(content, at({ x: 200 }))
    fireEvent.click(content)
    expect(onPress).not.toHaveBeenCalled()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(haptic).toHaveBeenCalledExactlyOnceWith('medium')
  })

  it('the row describes its actions', () => {
    const { content } = setup()
    // The hint is the row's description, not part of its name.
    expect(content).toHaveAccessibleName('Chat A')
    expect(content).toHaveAccessibleDescription(
      'Touch and hold for Delete, Rename.'
    )
    const hint = document.getElementById(
      content.getAttribute('aria-describedby')!
    )!
    expect(hint).toHaveClass('sr-only')
    expect(content.contains(hint)).toBe(false)
  })

  it('a row with no actions has no hint and no long press', () => {
    render(
      <SwipeRow actions={[]} onPress={vi.fn()}>
        <span>Bare</span>
      </SwipeRow>
    )
    const row = content('Bare')
    expect(row).not.toHaveAttribute('aria-describedby')
    hold(row)
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true
    })
    row.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('an unmounted row’s pending long press does nothing', () => {
    const { actions } = makeActions()
    const view = render(
      <SwipeRow actions={actions} onPress={vi.fn()}>
        <span>Chat A</span>
      </SwipeRow>
    )
    fireEvent.pointerDown(content('Chat A'), at({ x: 200 }))
    view.unmount()
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    expect(haptic).not.toHaveBeenCalled()
  })

  it('a later tap after the sheet closed presses as usual', () => {
    const { content, onPress } = setup()
    hold(content)
    fireEvent.pointerUp(content, at({ x: 200 }))
    fireEvent.click(content)
    fireEvent.click(within(sheet()).getByText('Cancel'))
    tap(content)
    expect(onPress).toHaveBeenCalledTimes(1)
  })
})
