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
  PINCH_MIN_SPREAD,
  usePinchZoom
} from '@/core/ui/use-pinch-zoom'

describe('the zoom constants', () => {
  it('are the agreed values', () => {
    expect(MIN_ZOOM).toBe(1)
    expect(MAX_ZOOM).toBe(4)
    expect(DOUBLE_TAP_ZOOM).toBe(2.5)
    expect(DOUBLE_TAP_MS).toBe(300)
    expect(DOUBLE_TAP_SLOP).toBe(24)
    expect(PINCH_MIN_SPREAD).toBe(8)
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

  it('keeps a letterboxed image from moving into the black', () => {
    // A 200 x 100 image on a 200 x 400 page, at 2x: 400 x 200. It overflows
    // the page by 100 px each side across, and not at all up and down.
    expect(clampPan(500, 300, 2, 200, 100, 200, 400)).toEqual({ x: 100, y: 0 })
    expect(clampPan(-500, -300, 2, 200, 100, 200, 400)).toEqual({
      x: -100,
      y: 0
    })
    // Smaller than the page both ways: it stays centred.
    expect(clampPan(50, 50, 1.5, 100, 100, 200, 400)).toEqual({ x: 0, y: 0 })
  })
})

type Size = [width: number, height: number]

/** The page's and the image's (unscaled) sizes, which the mocks report. */
let sizes: { page: Size; image: Size }

function Photo({ withImage }: { withImage: boolean }) {
  const { zoom, zoomed, reset, handlers, imageRef } = usePinchZoom()
  return (
    <>
      <div data-testid="photo" {...handlers}>
        {withImage && <img ref={imageRef} alt="" />}
      </div>
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

/**
 * A photo on its page: by default a 200 x 100 image filling a 200 x 100 page,
 * whose centre is (100, 50).
 */
function setup({
  page = [200, 100],
  image = page,
  withImage = true
}: { page?: Size; image?: Size; withImage?: boolean } = {}) {
  sizes = { page, image }
  const view = render(<Photo withImage={withImage} />)
  return { photo: screen.getByTestId('photo'), ...view }
}

/** The next animation frame, which draws the latest zoom. */
const frame = () => act(() => vi.advanceTimersToNextFrame())

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

const size = (el: HTMLElement) =>
  el.tagName === 'IMG' ? sizes.image : sizes.page

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
    function (this: HTMLElement) {
      return size(this)[0]
    }
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
    function (this: HTMLElement) {
      return size(this)[1]
    }
  )
  // The page's box on screen, from the top left.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      const [width, height] = size(this)
      return DOMRect.fromRect({ x: 0, y: 0, width, height })
    }
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
    const { photo } = setup()
    // 50 px apart, then 100: twice the size.
    pinch(photo, [75, 125], [50, 150])
    expect(zoom()).toBe('2 0 0 true')
  })

  it('stops at 4x however far the fingers spread', () => {
    const { photo } = setup()
    pinch(photo, [90, 110], [0, 200])
    expect(zoom()).toBe('4 0 0 true')
  })

  it('stops at 1x when pinched in', () => {
    const { photo } = setup()
    pinch(photo, [0, 200], [90, 110])
    expect(zoom()).toBe('1 0 0 false')
  })

  it('pinches on from the scale it is at', () => {
    const { photo } = setup()
    pinch(photo, [75, 125], [50, 150])
    pinch(photo, [50, 150], [25, 175])
    // 2x, then 1.5x more.
    expect(zoom()).toBe('3 0 0 true')
  })

  it('treats two fingers on one spot as no spread', () => {
    const { photo } = setup()
    pinch(photo, [100, 100], [100, 100])
    expect(zoom()).toBe('1 0 0 false')
  })

  it('ignores a third finger, and moves of a finger it never saw', () => {
    const { photo } = setup()
    fireEvent.pointerDown(photo, at({ x: 75, id: 1 }))
    fireEvent.pointerDown(photo, at({ x: 125, id: 2 }))
    fireEvent.pointerDown(photo, at({ x: 10, id: 3 }))
    fireEvent.pointerMove(photo, at({ x: 400, id: 3 }))
    fireEvent.pointerMove(photo, at({ x: 400, id: 9 }))
    fireEvent.pointerUp(photo, at({ x: 400, id: 3 }))
    frame()
    expect(zoom()).toBe('1 0 0 false')
    fireEvent.pointerMove(photo, at({ x: 50, id: 1 }))
    fireEvent.pointerMove(photo, at({ x: 150, id: 2 }))
    frame()
    expect(zoom()).toBe('2 0 0 true')
  })

  it('pinches about the point between the fingers', () => {
    const { photo } = setup()
    // Fingers either side of x 150, 50 px right of the centre, spread from
    // 40 px to 80 px apart: 2x, and what was under them stays under them.
    pinch(photo, [130, 170], [110, 190])
    expect(zoom()).toBe('2 -50 0 true')
  })

  it('moves the image with two fingers moving together', () => {
    const { photo } = setup()
    pinch(photo, [75, 125], [50, 150])
    pinch(photo, [50, 150], [80, 180])
    expect(zoom()).toBe('2 30 0 true')
  })

  it('starts a pinch from where fingers that landed together have spread to', () => {
    const { photo } = setup()
    fireEvent.pointerDown(photo, at({ x: 100, id: 1 }))
    fireEvent.pointerDown(photo, at({ x: 100, id: 2 }))
    // 20 px apart: from here the pinch counts, about x 90.
    fireEvent.pointerMove(photo, at({ x: 80, id: 1 }))
    frame()
    expect(zoom()).toBe('1 0 0 false')
    // 40 px apart: 2x, not a jump to 4x.
    fireEvent.pointerMove(photo, at({ x: 120, id: 2 }))
    frame()
    expect(zoom()).toBe('2 20 0 true')
  })

  it('pans a zoomed image with one finger, within its edges', () => {
    const { photo } = setup()
    pinch(photo, [75, 125], [50, 150])
    // At 2x it may move 100 px sideways and 50 px up or down.
    fireEvent.pointerDown(photo, at({ x: 100, y: 50 }))
    fireEvent.pointerMove(photo, at({ x: 140, y: 30 }))
    frame()
    expect(zoom()).toBe('2 40 -20 true')
    fireEvent.pointerMove(photo, at({ x: 400, y: -200 }))
    frame()
    expect(zoom()).toBe('2 100 -50 true')
    fireEvent.pointerUp(photo, at({ x: 400, y: -200 }))
  })

  it('keeps panning with the finger left after a pinch', () => {
    const { photo } = setup()
    pinch(photo, [75, 125], [50, 150], false)
    fireEvent.pointerUp(photo, at({ x: 150, id: 2 }))
    fireEvent.pointerMove(photo, at({ x: 80, id: 1 }))
    frame()
    expect(zoom()).toBe('2 30 0 true')
  })

  it('pulls the image back inside its edges as it is pinched in', () => {
    const { photo } = setup()
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

  it('keeps a letterboxed image from being dragged into the black', () => {
    // A 200 x 100 image on a 200 x 400 page (centre 100, 200).
    const { photo } = setup({ page: [200, 400], image: [200, 100] })
    pinch(photo, [75, 125], [50, 150])
    fireEvent.pointerDown(photo, at({ x: 100, y: 200 }))
    fireEvent.pointerMove(photo, at({ x: 300, y: 400 }))
    fireEvent.pointerUp(photo, at({ x: 300, y: 400 }))
    // 400 x 200 at 2x: 100 px to spare across, none up and down.
    expect(zoom()).toBe('2 100 0 true')
  })

  it('zooms within the page when it has no image (a placeholder)', () => {
    const { photo } = setup({ withImage: false })
    pinch(photo, [75, 125], [50, 150])
    expect(zoom()).toBe('2 0 0 true')
    // The page stands in for the image: 100 px to spare across at 2x.
    fireEvent.pointerDown(photo, at({ x: 100 }))
    fireEvent.pointerMove(photo, at({ x: 300 }))
    fireEvent.pointerUp(photo, at({ x: 300 }))
    expect(zoom()).toBe('2 100 0 true')
  })

  it('draws a move on the next frame, once however many moves came', () => {
    const { photo } = setup()
    pinch(photo, [75, 125], [50, 150])
    fireEvent.pointerDown(photo, at({ x: 100 }))
    fireEvent.pointerMove(photo, at({ x: 120 }))
    fireEvent.pointerMove(photo, at({ x: 140 }))
    expect(zoom()).toBe('2 0 0 true')
    frame()
    expect(zoom()).toBe('2 40 0 true')
    // A lift draws at once.
    fireEvent.pointerMove(photo, at({ x: 150 }))
    fireEvent.pointerUp(photo, at({ x: 150 }))
    expect(zoom()).toBe('2 50 0 true')
  })

  it('drops a frame still to come once gone', () => {
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame')
    const { photo, unmount } = setup()
    pinch(photo, [75, 125], [50, 150], false)
    cancel.mockClear()
    unmount()
    expect(cancel).toHaveBeenCalledWith(expect.any(Number))
    expect(cancel.mock.calls[0][0]).toBeGreaterThan(0)
    frame()
  })

  it('captures each finger it follows, but not a third', () => {
    const capture = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      value: capture,
      configurable: true
    })
    try {
      const { photo } = setup()
      fireEvent.pointerDown(photo, at({ x: 75, id: 1 }))
      fireEvent.pointerDown(photo, at({ x: 125, id: 2 }))
      fireEvent.pointerDown(photo, at({ x: 10, id: 3 }))
      expect(capture.mock.calls).toEqual([[1], [2]])
      expect(capture.mock.contexts).toEqual([photo, photo])
    } finally {
      delete (HTMLElement.prototype as { setPointerCapture?: unknown })
        .setPointerCapture
    }
  })

  it('lets go of a finger whose capture is lost', () => {
    const { photo } = setup()
    pinch(photo, [75, 125], [50, 150])
    fireEvent.pointerDown(photo, at({ x: 100 }))
    fireEvent.pointerMove(photo, at({ x: 140 }))
    fireEvent.lostPointerCapture(photo, at({ x: 140 }))
    expect(zoom()).toBe('2 40 0 true')
    // A mouse moving on after it was released off the image pans nothing.
    fireEvent.pointerMove(photo, at({ x: 180 }))
    frame()
    expect(zoom()).toBe('2 40 0 true')
    // And the lost touch was no tap.
    tap(photo, { x: 140 })
    expect(zoom()).toBe('2 40 0 true')
  })

  it('ignores a lost capture that bubbled up from inside the page', () => {
    const { photo } = setup()
    pinch(photo, [75, 125], [50, 150])
    fireEvent.pointerDown(photo, at({ x: 100 }))
    // The image inside lost a capture it held for this pointer: the page
    // still holds the finger, which pans on.
    fireEvent.lostPointerCapture(photo.querySelector('img')!, at({ x: 100 }))
    fireEvent.pointerMove(photo, at({ x: 140 }))
    frame()
    expect(zoom()).toBe('2 40 0 true')
  })

  it('unzooms when the window resizes or the device rotates', () => {
    const { photo } = setup()
    for (const type of ['resize', 'orientationchange']) {
      pinch(photo, [75, 125], [50, 150])
      frame()
      expect(zoom()).toBe('2 0 0 true')
      act(() => {
        window.dispatchEvent(new Event(type))
      })
      expect(zoom()).toBe('1 0 0 false')
    }
  })

  it('stops listening for resizes once unmounted', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = setup()
    unmount()
    const types = remove.mock.calls.map(([type]) => type)
    expect(types).toEqual(
      expect.arrayContaining(['resize', 'orientationchange'])
    )
  })

  it('does not pan an unzoomed image', () => {
    const { photo } = setup()
    fireEvent.pointerDown(photo, at({ x: 100 }))
    fireEvent.pointerMove(photo, at({ x: 180 }))
    fireEvent.pointerUp(photo, at({ x: 180 }))
    expect(zoom()).toBe('1 0 0 false')
  })

  it('zooms to 2.5x on a double tap, and back to 1x on the next', () => {
    const { photo } = setup()
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
    const { photo } = setup()
    // 40 px right of and 10 px above the centre (100, 50) stays under the
    // finger: the image moves 1.5 * 40 left and 1.5 * 10 down.
    tap(photo, { x: 140, y: 40 })
    tap(photo, { x: 140, y: 40 })
    expect(zoom()).toBe('2.5 -60 15 true')
  })

  it('allows the second tap to land a little off the first', () => {
    const { photo } = setup()
    tap(photo, { x: 100 })
    tap(photo, { x: 110 })
    // Zoomed in on the second tap, 10 px right of the centre.
    expect(zoom()).toBe('2.5 -15 0 true')
  })

  it('does nothing for a single slow tap', () => {
    const { photo } = setup()
    tap(photo, { x: 100 })
    expect(zoom()).toBe('1 0 0 false')
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 100)
    tap(photo, { x: 100 })
    expect(zoom()).toBe('1 0 0 false')
  })

  it('counts a tap that wobbles a little', () => {
    const { photo } = setup()
    tap(photo, { x: 100 })
    fireEvent.pointerDown(photo, at({ x: 100 }))
    fireEvent.pointerMove(photo, at({ x: 100 + DOUBLE_TAP_SLOP / 2 }))
    fireEvent.pointerUp(photo, at({ x: 100 }))
    expect(zoom()).toBe('2.5 0 0 true')
  })

  it('needs both taps in one place', () => {
    const { photo } = setup()
    tap(photo, { x: 100 })
    tap(photo, { x: 100 + DOUBLE_TAP_SLOP + 10 })
    expect(zoom()).toBe('1 0 0 false')
  })

  it('does not count a drag, a pinch or a cancelled touch as a tap', () => {
    const { photo } = setup()
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
    const { photo } = setup()
    pinch(photo, [75, 125], [50, 150], false)
    act(() => screen.getByRole('button', { name: 'Reset' }).click())
    expect(zoom()).toBe('1 0 0 false')
    // The gesture in progress is dropped too.
    fireEvent.pointerMove(photo, at({ x: 0, id: 1 }))
    fireEvent.pointerMove(photo, at({ x: 200, id: 2 }))
    frame()
    expect(zoom()).toBe('1 0 0 false')
  })
})
