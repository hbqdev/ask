import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useEdgeSwipe, type EdgeSwipeOptions } from '@/core/nav/use-edge-swipe'

const WIDTH = 390
let savedWidth: number

beforeEach(() => {
  savedWidth = window.innerWidth
  window.innerWidth = WIDTH
})

afterEach(() => {
  window.innerWidth = savedWidth
})

function Pad(props: { onBack: () => void; opts?: EdgeSwipeOptions }) {
  const handlers = useEdgeSwipe(props.onBack, props.opts)
  return <div data-testid="pad" {...handlers} />
}

function setup(opts?: EdgeSwipeOptions) {
  const onBack = vi.fn()
  render(<Pad onBack={onBack} opts={opts} />)
  return { onBack, pad: screen.getByTestId('pad') }
}

type Point = { x: number; y?: number; id?: number; primary?: boolean }

function at({ x, y = 300, id = 1, primary = true }: Point) {
  return { clientX: x, clientY: y, pointerId: id, isPrimary: primary }
}

/** A drag along the given points: down at the first, up at the last. */
function drag(pad: HTMLElement, points: Point[]) {
  fireEvent.pointerDown(pad, at(points[0]))
  for (const p of points.slice(1)) fireEvent.pointerMove(pad, at(p))
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
    drag(pad, [{ x: 100 }, { x: 250 }])
    expect(onBack).not.toHaveBeenCalled()
    drag(pad, [{ x: 100 }, { x: 300 }])
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
})
