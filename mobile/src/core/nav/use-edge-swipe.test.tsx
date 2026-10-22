import { fireEvent, render, screen } from '@testing-library/react'
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
  const handlers = useEdgeSwipe(props.onBack, props.opts)
  return <div data-testid="pad" {...handlers} />
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

  it('reads the time from performance.now by default', () => {
    const now = vi.spyOn(performance, 'now')
    const onBack = vi.fn()
    render(<Pad onBack={onBack} />)
    const pad = screen.getByTestId('pad')
    now.mockReturnValue(0)
    fireEvent.pointerDown(pad, at({ x: 10 }))
    now.mockReturnValue(20)
    fireEvent.pointerMove(pad, at({ x: 30 }))
    now.mockReturnValue(40)
    fireEvent.pointerMove(pad, at({ x: 60 }))
    fireEvent.pointerUp(pad, at({ x: 60 }))
    expect(now).toHaveBeenCalled()
    expect(onBack).toHaveBeenCalledTimes(1)
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
