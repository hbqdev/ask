import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clampPan,
  clampZoom,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP,
  DOUBLE_TAP_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  usePinchZoom
} from '@/core/ui/use-pinch-zoom'

describe('the zoom constants', () => {
  it('are the agreed values', () => {
    expect(MIN_ZOOM).toBe(1)
    expect(MAX_ZOOM).toBe(4)
    expect(DOUBLE_TAP_ZOOM).toBe(2.5)
    expect(DOUBLE_TAP_MS).toBe(300)
    expect(DOUBLE_TAP_SLOP).toBe(24)
  })
})

describe('clampZoom', () => {
  it('keeps a scale between 1 and 4', () => {
    expect(clampZoom(0.4)).toBe(1)
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(2.2)).toBe(2.2)
    expect(clampZoom(4)).toBe(4)
    expect(clampZoom(9)).toBe(4)
  })
})

describe('clampPan', () => {
  it('lets the image move at most (scale - 1) half-sizes either way', () => {
    // At 3x a 200 x 100 image may move 200 px sideways and 100 px up or down.
    expect(clampPan(50, -20, 3, 200, 100)).toEqual({ x: 50, y: -20 })
    expect(clampPan(500, -500, 3, 200, 100)).toEqual({ x: 200, y: -100 })
    expect(clampPan(-500, 500, 3, 200, 100)).toEqual({ x: -200, y: 100 })
  })

  it('pins an unzoomed image in place', () => {
    expect(clampPan(40, -40, 1, 200, 100)).toEqual({ x: 0, y: 0 })
  })
})

const WIDTH = 200
const HEIGHT = 100

function Photo() {
  const { zoom, zoomed, reset, handlers } = usePinchZoom()
  return (
    <>
      <div data-testid="photo" {...handlers} />
      <output data-testid="zoom">
        {`${zoom.scale} ${zoom.x} ${zoom.y} ${zoomed}`}
      </output>
      <button type="button" onClick={reset}>
        Reset
      </button>
    </>
  )
}

type Point = { x: number; y?: number; id?: number }
const at = ({ x, y = 50, id = 1 }: Point) => ({
  clientX: x,
  clientY: y,
  pointerId: id
})

function setup() {
  render(<Photo />)
  return screen.getByTestId('photo')
}

/** The zoom as "scale x y zoomed". */
const zoom = () => screen.getByTestId('zoom').textContent

/** A tap: down and up in one place. */
function tap(el: HTMLElement, p: Point) {
  fireEvent.pointerDown(el, at(p))
  fireEvent.pointerUp(el, at(p))
}

/** Two fingers down at `from` (x of each), then moved to `to`. */
function pinch(
  el: HTMLElement,
  from: [number, number],
  to: [number, number],
  lift = true
) {
  fireEvent.pointerDown(el, at({ x: from[0], id: 1 }))
  fireEvent.pointerDown(el, at({ x: from[1], id: 2 }))
  fireEvent.pointerMove(el, at({ x: to[0], id: 1 }))
  fireEvent.pointerMove(el, at({ x: to[1], id: 2 }))
  if (!lift) return
  fireEvent.pointerUp(el, at({ x: to[0], id: 1 }))
  fireEvent.pointerUp(el, at({ x: to[1], id: 2 }))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(WIDTH)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(HEIGHT)
  // The photo's box on screen: its centre is (100, 50).
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 0, y: 0, width: WIDTH, height: HEIGHT })
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('usePinchZoom', () => {
  it('starts unzoomed', () => {
    setup()
    expect(zoom()).toBe('1 0 0 false')
  })

  it('scales by how far two fingers spread', () => {
    const photo = setup()
    // 50 px apart, then 100: twice the size.
    pinch(photo, [75, 125], [50, 150])
    expect(zoom()).toBe('2 0 0 true')
  })

  it('stops at 4x however far the fingers spread', () => {
    const photo = setup()
    pinch(photo, [90, 110], [0, 200])
    expect(zoom()).toBe('4 0 0 true')
  })

  it('stops at 1x when pinched in', () => {
    const photo = setup()
    pinch(photo, [0, 200], [90, 110])
    expect(zoom()).toBe('1 0 0 false')
  })

  it('pinches on from the scale it is at', () => {
    const photo = setup()
    pinch(photo, [75, 125], [50, 150])
    pinch(photo, [50, 150], [25, 175])
    // 2x, then 1.5x more.
    expect(zoom()).toBe('3 0 0 true')
  })

  it('treats two fingers on one spot as no spread', () => {
    const photo = setup()
    pinch(photo, [100, 100], [100, 100])
    expect(zoom()).toBe('1 0 0 false')
  })

  it('ignores a third finger, and moves of a finger it never saw', () => {
    const photo = setup()
    fireEvent.pointerDown(photo, at({ x: 75, id: 1 }))
    fireEvent.pointerDown(photo, at({ x: 125, id: 2 }))
    fireEvent.pointerDown(photo, at({ x: 10, id: 3 }))
    fireEvent.pointerMove(photo, at({ x: 400, id: 3 }))
    fireEvent.pointerMove(photo, at({ x: 400, id: 9 }))
    fireEvent.pointerUp(photo, at({ x: 400, id: 3 }))
    expect(zoom()).toBe('1 0 0 false')
    fireEvent.pointerMove(photo, at({ x: 50, id: 1 }))
    fireEvent.pointerMove(photo, at({ x: 150, id: 2 }))
    expect(zoom()).toBe('2 0 0 true')
  })

  it('pans a zoomed image with one finger, within its edges', () => {
    const photo = setup()
    pinch(photo, [75, 125], [50, 150])
    // At 2x it may move 100 px sideways and 50 px up or down.
    fireEvent.pointerDown(photo, at({ x: 100, y: 50 }))
    fireEvent.pointerMove(photo, at({ x: 140, y: 30 }))
    expect(zoom()).toBe('2 40 -20 true')
    fireEvent.pointerMove(photo, at({ x: 400, y: -200 }))
    expect(zoom()).toBe('2 100 -50 true')
    fireEvent.pointerUp(photo, at({ x: 400, y: -200 }))
  })

  it('keeps panning with the finger left after a pinch', () => {
    const photo = setup()
    pinch(photo, [75, 125], [50, 150], false)
    fireEvent.pointerUp(photo, at({ x: 150, id: 2 }))
    fireEvent.pointerMove(photo, at({ x: 80, id: 1 }))
    expect(zoom()).toBe('2 30 0 true')
  })

  it('pulls the image back inside its edges as it is pinched in', () => {
    const photo = setup()
    pinch(photo, [75, 125], [25, 175])
    // 3x: pan as far right as it goes (100 * 2 = 200 px).
    fireEvent.pointerDown(photo, at({ x: 0 }))
    fireEvent.pointerMove(photo, at({ x: 300 }))
    fireEvent.pointerUp(photo, at({ x: 300 }))
    expect(zoom()).toBe('3 200 0 true')
    // Back to 1.5x: at most 50 px.
    pinch(photo, [0, 200], [50, 150])
    expect(zoom()).toBe('1.5 50 0 true')
  })

  it('does not pan an unzoomed image', () => {
    const photo = setup()
    fireEvent.pointerDown(photo, at({ x: 100 }))
    fireEvent.pointerMove(photo, at({ x: 180 }))
    fireEvent.pointerUp(photo, at({ x: 180 }))
    expect(zoom()).toBe('1 0 0 false')
  })

  it('zooms to 2.5x on a double tap, and back to 1x on the next', () => {
    const photo = setup()
    tap(photo, { x: 100 })
    vi.advanceTimersByTime(DOUBLE_TAP_MS - 50)
    tap(photo, { x: 100 })
    expect(zoom()).toBe('2.5 0 0 true')

    vi.advanceTimersByTime(1000)
    tap(photo, { x: 100 })
    vi.advanceTimersByTime(100)
    tap(photo, { x: 100 })
    expect(zoom()).toBe('1 0 0 false')
  })

  it('zooms in on the point double-tapped', () => {
    const photo = setup()
    // 40 px right of and 10 px above the centre (100, 50) stays under the
    // finger: the image moves 1.5 * 40 left and 1.5 * 10 down.
    tap(photo, { x: 140, y: 40 })
    tap(photo, { x: 140, y: 40 })
    expect(zoom()).toBe('2.5 -60 15 true')
  })

  it('allows the second tap to land a little off the first', () => {
    const photo = setup()
    tap(photo, { x: 100 })
    tap(photo, { x: 110 })
    // Zoomed in on the second tap, 10 px right of the centre.
    expect(zoom()).toBe('2.5 -15 0 true')
  })

  it('does nothing for a single slow tap', () => {
    const photo = setup()
    tap(photo, { x: 100 })
    expect(zoom()).toBe('1 0 0 false')
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 100)
    tap(photo, { x: 100 })
    expect(zoom()).toBe('1 0 0 false')
  })

  it('counts a tap that wobbles a little', () => {
    const photo = setup()
    tap(photo, { x: 100 })
    fireEvent.pointerDown(photo, at({ x: 100 }))
    fireEvent.pointerMove(photo, at({ x: 100 + DOUBLE_TAP_SLOP / 2 }))
    fireEvent.pointerUp(photo, at({ x: 100 }))
    expect(zoom()).toBe('2.5 0 0 true')
  })

  it('needs both taps in one place', () => {
    const photo = setup()
    tap(photo, { x: 100 })
    tap(photo, { x: 100 + DOUBLE_TAP_SLOP + 10 })
    expect(zoom()).toBe('1 0 0 false')
  })

  it('does not count a drag, a pinch or a cancelled touch as a tap', () => {
    const photo = setup()
    // A drag, then a tap.
    fireEvent.pointerDown(photo, at({ x: 100 }))
    fireEvent.pointerMove(photo, at({ x: 160 }))
    fireEvent.pointerUp(photo, at({ x: 100 }))
    tap(photo, { x: 100 })
    expect(zoom()).toBe('1 0 0 false')

    vi.advanceTimersByTime(1000)
    // A cancelled touch (the strip took the swipe), then a tap.
    fireEvent.pointerDown(photo, at({ x: 100 }))
    fireEvent.pointerCancel(photo, at({ x: 100 }))
    tap(photo, { x: 100 })
    expect(zoom()).toBe('1 0 0 false')

    vi.advanceTimersByTime(1000)
    // A two-finger touch that does not spread, then a tap.
    pinch(photo, [90, 110], [90, 110])
    tap(photo, { x: 100 })
    expect(zoom()).toBe('1 0 0 false')
  })

  it('resets to unzoomed', () => {
    const photo = setup()
    pinch(photo, [75, 125], [50, 150], false)
    act(() => screen.getByRole('button', { name: 'Reset' }).click())
    expect(zoom()).toBe('1 0 0 false')
    // The gesture in progress is dropped too.
    fireEvent.pointerMove(photo, at({ x: 0, id: 1 }))
    fireEvent.pointerMove(photo, at({ x: 200, id: 2 }))
    expect(zoom()).toBe('1 0 0 false')
  })
})
