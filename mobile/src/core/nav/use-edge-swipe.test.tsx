import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FLICK_VELOCITY,
  useEdgeSwipe,
  type EdgeSwipeOptions
} from '@/core/nav/use-edge-swipe'

const WIDTH = 390
let savedWidth: number

// The gesture's clock, in ms. Each event in drag() comes STEP ms after the
// one before, so a drag is slow (well under FLICK_VELOCITY) unless a test
// times its points itself.
let clock = 0
const STEP = 100

beforeEach(() => {
  savedWidth = window.innerWidth
  window.innerWidth = WIDTH
  clock = 0
})

afterEach(() => {
  window.innerWidth = savedWidth
  vi.restoreAllMocks()
})

function Pad(props: { onBack: () => void; opts?: EdgeSwipeOptions }) {
  const { cancel, ...handlers } = useEdgeSwipe(props.onBack, props.opts)
  return (
    <div data-testid="pad" {...handlers}>
      <button type="button" onClick={cancel}>
        cancel
      </button>
    </div>
  )
}

function setup(opts?: EdgeSwipeOptions) {
  const onBack = vi.fn()
  render(<Pad onBack={onBack} opts={{ now: () => clock, ...opts }} />)
  return { onBack, pad: screen.getByTestId('pad') }
}

type Point = {
  x: number
  y?: number
  id?: number
  primary?: boolean
  /** When the event comes, in ms; STEP after the one before by default. */
  t?: number
}

function at({ x, y = 300, id = 1, primary = true }: Point) {
  return { clientX: x, clientY: y, pointerId: id, isPrimary: primary }
}

/** Fires a pointer event that happened at `timeStamp` (ms). */
function timed(
  el: HTMLElement,
  type: 'pointerDown' | 'pointerMove' | 'pointerUp',
  x: number,
  timeStamp: number
) {
  const event = createEvent[type](el, at({ x }))
  Object.defineProperty(event, 'timeStamp', { value: timeStamp })
  fireEvent(el, event)
}

function tick(p: Point) {
  clock = p.t ?? clock + STEP
}

/** A drag along the given points: down at the first, up at the last. */
function drag(pad: HTMLElement, points: Point[]) {
  tick(points[0])
  fireEvent.pointerDown(pad, at(points[0]))
  for (const p of points.slice(1)) {
    tick(p)
    fireEvent.pointerMove(pad, at(p))
  }
  // Released where and when the last move was.
  fireEvent.pointerUp(pad, at(points[points.length - 1]))
}

/** A drag whose release comes `upAfter` ms after its last move. */
function dragUp(pad: HTMLElement, points: Point[], upAfter: number) {
  tick(points[0])
  fireEvent.pointerDown(pad, at(points[0]))
  for (const p of points.slice(1)) {
    tick(p)
    fireEvent.pointerMove(pad, at(p))
  }
  clock += upAfter
  fireEvent.pointerUp(pad, at(points[points.length - 1]))
}

describe('useEdgeSwipe', () => {
  it('goes back on a drag from the left edge past a third of the width', () => {
    const { onBack, pad } = setup()
    drag(pad, [{ x: 10 }, { x: 100 }, { x: 200 }])
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('ignores a drag that starts away from the edge', () => {
    const { onBack, pad } = setup()
    drag(pad, [{ x: 100 }, { x: 200 }, { x: 300 }])
    expect(onBack).not.toHaveBeenCalled()
  })

  it('ignores a short drag and reports it as cancelled', () => {
    const onDrag = vi.fn()
    const onCancel = vi.fn()
    const { onBack, pad } = setup({ onDrag, onCancel })
    drag(pad, [{ x: 10 }, { x: 40 }, { x: 60 }])
    expect(onBack).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('reports the horizontal distance while dragging', () => {
    const onDrag = vi.fn()
    const { pad } = setup({ onDrag })
    fireEvent.pointerDown(pad, at({ x: 10 }))
    // Inside the slop: the gesture is not yet a swipe.
    fireEvent.pointerMove(pad, at({ x: 15 }))
    expect(onDrag).not.toHaveBeenCalled()
    fireEvent.pointerMove(pad, at({ x: 60 }))
    fireEvent.pointerMove(pad, at({ x: 5 }))
    expect(onDrag.mock.calls).toEqual([[50], [0]])
  })

  it('leaves a mostly vertical drag to scrolling', () => {
    const onDrag = vi.fn()
    const onCancel = vi.fn()
    const { onBack, pad } = setup({ onDrag, onCancel })
    drag(pad, [
      { x: 10, y: 300 },
      { x: 14, y: 360 },
      { x: 200, y: 380 }
    ])
    expect(onBack).not.toHaveBeenCalled()
    expect(onDrag).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('honours a custom edge and threshold', () => {
    const { onBack, pad } = setup({ edge: 120, threshold: 0.5 })
    // Slow drags (40 px a step), so no flick decides it.
    drag(pad, [{ x: 100 }, { x: 140 }, { x: 180 }, { x: 220 }, { x: 250 }])
    expect(onBack).not.toHaveBeenCalled()
    drag(pad, [
      { x: 100 },
      { x: 140 },
      { x: 180 },
      { x: 220 },
      { x: 260 },
      { x: 300 }
    ])
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('tracks only the pointer that started the drag', () => {
    const { onBack, pad } = setup()
    fireEvent.pointerDown(pad, at({ x: 10, id: 1 }))
    fireEvent.pointerDown(pad, at({ x: 10, id: 2, primary: false }))
    fireEvent.pointerMove(pad, at({ x: 300, id: 2 }))
    fireEvent.pointerUp(pad, at({ x: 300, id: 2 }))
    expect(onBack).not.toHaveBeenCalled()
    fireEvent.pointerMove(pad, at({ x: 200, id: 1 }))
    fireEvent.pointerUp(pad, at({ x: 200, id: 1 }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('ignores moves and releases with no drag in progress', () => {
    const onDrag = vi.fn()
    const { onBack, pad } = setup({ onDrag })
    fireEvent.pointerMove(pad, at({ x: 200 }))
    fireEvent.pointerUp(pad, at({ x: 200 }))
    fireEvent.pointerCancel(pad, at({ x: 200 }))
    expect(onBack).not.toHaveBeenCalled()
    expect(onDrag).not.toHaveBeenCalled()
  })

  it('reports a cancelled swipe, and only one that had started', () => {
    const onCancel = vi.fn()
    const { onBack, pad } = setup({ onCancel })
    fireEvent.pointerDown(pad, at({ x: 10 }))
    fireEvent.pointerCancel(pad, at({ x: 10 }))
    expect(onCancel).not.toHaveBeenCalled()

    fireEvent.pointerDown(pad, at({ x: 10 }))
    fireEvent.pointerMove(pad, at({ x: 200 }))
    fireEvent.pointerCancel(pad, at({ x: 200 }))
    // The release after a cancel is not a swipe.
    fireEvent.pointerUp(pad, at({ x: 200 }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onBack).not.toHaveBeenCalled()
  })

  it('captures the pointer once the drag is a swipe', () => {
    const capture = vi.fn()
    const { pad } = setup()
    pad.setPointerCapture = capture
    fireEvent.pointerDown(pad, at({ x: 10, id: 7 }))
    fireEvent.pointerMove(pad, at({ x: 12, id: 7 }))
    expect(capture).not.toHaveBeenCalled()
    fireEvent.pointerMove(pad, at({ x: 80, id: 7 }))
    fireEvent.pointerMove(pad, at({ x: 90, id: 7 }))
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith(7)
  })

  it('keeps the default threshold of a third of the width for a slow drag', () => {
    const { onBack, pad } = setup()
    // 128 px of 390 is under a third: a slow drag that far snaps back,
    // 130 px is past it.
    drag(pad, [{ x: 10 }, { x: 50 }, { x: 90 }, { x: 130 }, { x: 138 }])
    expect(onBack).not.toHaveBeenCalled()
    drag(pad, [{ x: 10 }, { x: 50 }, { x: 90 }, { x: 130 }, { x: 140 }])
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('a fast short flick goes back', () => {
    const onCancel = vi.fn()
    const { onBack, pad } = setup({ onCancel })
    // 40 px, the last 25 of them in 20 ms: 1.25 px/ms.
    drag(pad, [
      { x: 10, t: 0 },
      { x: 25, t: 30 },
      { x: 50, t: 50 }
    ])
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('goes back at exactly FLICK_VELOCITY', () => {
    const { onBack, pad } = setup()
    drag(pad, [
      { x: 10, t: 0 },
      { x: 30, t: 100 },
      { x: 30 + 20 * FLICK_VELOCITY, t: 120 }
    ])
    expect(FLICK_VELOCITY).toBe(0.5)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('a slow short drag snaps back', () => {
    const onCancel = vi.fn()
    const { onBack, pad } = setup({ onCancel })
    // 40 px at 0.2 px/ms.
    drag(pad, [
      { x: 10, t: 0 },
      { x: 30, t: 100 },
      { x: 50, t: 200 }
    ])
    expect(onBack).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('a fast flick under 10px does not', () => {
    const { onBack, pad } = setup()
    // 9 px in 5 ms never became a swipe.
    drag(pad, [
      { x: 10, t: 0 },
      { x: 19, t: 5 }
    ])
    expect(onBack).not.toHaveBeenCalled()
  })

  it('a fast flick that turned back left at the end does not', () => {
    const { onBack, pad } = setup()
    drag(pad, [
      { x: 10, t: 0 },
      { x: 60, t: 20 },
      { x: 40, t: 40 }
    ])
    expect(onBack).not.toHaveBeenCalled()
  })

  it('a fast drag held still before the release does not flick', () => {
    const { onBack, pad } = setup()
    dragUp(
      pad,
      [
        { x: 10, t: 0 },
        { x: 30, t: 10 },
        { x: 60, t: 20 }
      ],
      300
    )
    expect(onBack).not.toHaveBeenCalled()
  })

  it('counts the release as a move when it lands further on', () => {
    const { onBack, pad } = setup()
    // Slow moves, then the release lands 30 px further 20 ms later.
    tick({ x: 10, t: 0 })
    fireEvent.pointerDown(pad, at({ x: 10 }))
    clock = 100
    fireEvent.pointerMove(pad, at({ x: 30 }))
    clock = 200
    fireEvent.pointerMove(pad, at({ x: 50 }))
    clock = 220
    fireEvent.pointerUp(pad, at({ x: 80 }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('ignores two moves at the same instant when measuring the speed', () => {
    const { onBack, pad } = setup()
    drag(pad, [
      { x: 10, t: 0 },
      { x: 30, t: 100 },
      { x: 50, t: 100 }
    ])
    expect(onBack).not.toHaveBeenCalled()
  })

  it('honours a custom flick velocity', () => {
    const { onBack, pad } = setup({ flickVelocity: 2 })
    drag(pad, [
      { x: 10, t: 0 },
      { x: 25, t: 30 },
      { x: 50, t: 50 }
    ])
    expect(onBack).not.toHaveBeenCalled()
  })

  it('times each event by its own timeStamp by default (not when it is handled)', () => {
    // The handlers run back to back after a stall (performance.now 1 ms
    // apart), but the moves happened 100 ms apart: a slow drag.
    let handled = 0
    vi.spyOn(performance, 'now').mockImplementation(() => ++handled)
    const onBack = vi.fn()
    render(<Pad onBack={onBack} />)
    const pad = screen.getByTestId('pad')
    timed(pad, 'pointerDown', 10, 1000)
    timed(pad, 'pointerMove', 30, 1100)
    timed(pad, 'pointerMove', 50, 1200)
    timed(pad, 'pointerUp', 50, 1201)
    expect(onBack).not.toHaveBeenCalled()

    // And a real flick, by its timestamps, goes back.
    timed(pad, 'pointerDown', 10, 2000)
    timed(pad, 'pointerMove', 34, 2016)
    timed(pad, 'pointerMove', 58, 2032)
    timed(pad, 'pointerUp', 58, 2040)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('a slow peek released with a tiny last jitter does not go back', () => {
    const onCancel = vi.fn()
    const { onBack, pad } = setup({ onCancel })
    // 0.2 px/ms in 20 ms steps, then the release 1 ms later, 2 px on.
    drag(pad, [
      { x: 10, t: 0 },
      { x: 14, t: 20 },
      { x: 18, t: 40 },
      { x: 22, t: 60 },
      { x: 26, t: 80 },
      { x: 30, t: 100 }
    ])
    expect(onCancel).toHaveBeenCalledTimes(1)
    onCancel.mockClear()
    tick({ x: 10, t: 1000 })
    fireEvent.pointerDown(pad, at({ x: 10 }))
    for (const [x, t] of [
      [14, 1020],
      [18, 1040],
      [22, 1060],
      [26, 1080],
      [30, 1100]
    ]) {
      clock = t
      fireEvent.pointerMove(pad, at({ x }))
    }
    clock = 1101
    fireEvent.pointerUp(pad, at({ x: 32 }))
    expect(onBack).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('a genuine fast flick at the touch rate goes back', () => {
    const { onBack, pad } = setup()
    // 1.5 px/ms, a move every 16 ms, released 8 ms after the last move.
    tick({ x: 10, t: 0 })
    fireEvent.pointerDown(pad, at({ x: 10 }))
    for (const [x, t] of [
      [34, 16],
      [58, 32],
      [82, 48]
    ]) {
      clock = t
      fireEvent.pointerMove(pad, at({ x }))
    }
    clock = 56
    fireEvent.pointerUp(pad, at({ x: 82 }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('a fast flick whose lift-off wobbles 1–2 px left still goes back', () => {
    const { onBack, pad } = setup()
    // 1.5 px/ms, a move every 16 ms; the last move or the release rolls back.
    for (const [moves, up] of [
      [[34, 58, 82, 81], 81],
      [[34, 58, 82, 80], 80],
      [[34, 58, 82], 80]
    ] as const) {
      onBack.mockClear()
      clock = 0
      fireEvent.pointerDown(pad, at({ x: 10 }))
      moves.forEach((x, i) => {
        clock = 16 * (i + 1)
        fireEvent.pointerMove(pad, at({ x }))
      })
      clock += 8
      fireEvent.pointerUp(pad, at({ x: up }))
      expect(onBack).toHaveBeenCalledTimes(1)
    }
  })

  it('a slow peek with a 2 px wobble at the release still does not go back', () => {
    const onCancel = vi.fn()
    const { onBack, pad } = setup({ onCancel })
    // 0.2 px/ms in 20 ms steps, released 2 px back.
    drag(pad, [
      { x: 10, t: 0 },
      { x: 14, t: 20 },
      { x: 18, t: 40 },
      { x: 22, t: 60 },
      { x: 26, t: 80 },
      { x: 30, t: 100 },
      { x: 28, t: 104 }
    ])
    expect(onBack).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('a finger drifting back left 1 px at a time is no flick', () => {
    const { onBack, pad } = setup()
    // Fast right, then a steady drift left: each step is within the wobble,
    // but together they are a move left.
    drag(pad, [
      { x: 10, t: 0 },
      { x: 60, t: 20 },
      { x: 59, t: 28 },
      { x: 58, t: 36 },
      { x: 57, t: 44 },
      { x: 56, t: 52 },
      { x: 55, t: 60 },
      { x: 54, t: 68 }
    ])
    expect(onBack).not.toHaveBeenCalled()
  })

  it('a burst of moves under 4 ms (a stall flushed at once) is no flick', () => {
    const { onBack, pad } = setup()
    drag(pad, [
      { x: 10, t: 0 },
      { x: 30, t: 100 },
      { x: 40, t: 101 },
      { x: 50, t: 102 }
    ])
    expect(onBack).not.toHaveBeenCalled()
  })

  it('measures the speed since the last turn back right only', () => {
    const { onBack, pad } = setup()
    // Fast right, then back left: the last 40 ms moved left.
    drag(pad, [
      { x: 10, t: 0 },
      { x: 70, t: 20 },
      { x: 60, t: 30 },
      { x: 50, t: 40 }
    ])
    expect(onBack).not.toHaveBeenCalled()
  })

  it('cancel() drops the drag in progress', () => {
    const onDrag = vi.fn()
    const { onBack, pad } = setup({ onDrag })
    fireEvent.pointerDown(pad, at({ x: 10 }))
    fireEvent.pointerMove(pad, at({ x: 40 }))
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    onDrag.mockClear()
    fireEvent.pointerMove(pad, at({ x: 300 }))
    fireEvent.pointerUp(pad, at({ x: 300 }))
    expect(onDrag).not.toHaveBeenCalled()
    expect(onBack).not.toHaveBeenCalled()
  })

  it('ignores a press in a portal of the screen’s (a sheet it opened)', () => {
    const onBack = vi.fn()
    function WithSheet() {
      const handlers = useEdgeSwipe(onBack, { now: () => clock })
      return (
        <div data-testid="screen" {...handlers}>
          {createPortal(<div data-testid="sheet" />, document.body)}
        </div>
      )
    }
    render(<WithSheet />)
    // React bubbles the sheet's events to the screen, though it is elsewhere
    // in the page.
    drag(screen.getByTestId('sheet'), [{ x: 10 }, { x: 40 }, { x: 300 }])
    expect(onBack).not.toHaveBeenCalled()
    drag(screen.getByTestId('screen'), [{ x: 10 }, { x: 40 }, { x: 300 }])
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
