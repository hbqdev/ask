// Pinch and double-tap zoom for one image on its page, as the image viewer's
// own gesture: the page itself never zooms (index.html, styles.css). As in
// Photos:
// - two fingers scale the image about the point between them, and move it as
//   they move together;
// - one finger pans it while it is zoomed;
// - a second tap soon after the first, in about the same place, zooms in on
//   that point, or back out.
// The image moves itself with `translate(x px, y px) scale(scale)` about its
// centre, which is the page's centre (the page centres it). The pan never
// shows the page past the image's edges: on an axis where the scaled image is
// smaller than the page, it stays centred.
//
// The handlers go on the page, so a pinch that starts on the black around a
// letterboxed image still works; `imageRef` goes on the image, to measure it.
// While unzoomed the page is `touch-action: pan-x`, so a one-finger swipe
// still pages the viewer's strip (the browser takes the pan and cancels the
// pointer); zoomed it is `touch-action: none` and every touch comes here.
// Moves are drawn at most once a frame.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject
} from 'react'

export const MIN_ZOOM = 1
export const MAX_ZOOM = 4
/** The scale a double tap zooms to. */
export const DOUBLE_TAP_ZOOM = 2.5
/** How soon, in ms, the second tap must follow the first. */
export const DOUBLE_TAP_MS = 300
/**
 * How close, in px, the second tap must land to the first; also how far a
 * finger can move and still be tapping.
 */
export const DOUBLE_TAP_SLOP = 24
/**
 * How far apart, in px, two fingers must be before their spread counts: from
 * closer, a small move would be a huge ratio.
 */
export const PINCH_MIN_SPREAD = 8

export type Zoom = { scale: number; x: number; y: number }

type Handler = (e: PointerEvent<HTMLElement>) => void

export type PinchZoomHandlers = {
  onPointerDown: Handler
  onPointerMove: Handler
  onPointerUp: Handler
  onPointerCancel: Handler
  onLostPointerCapture: Handler
}

export type PinchZoom = {
  zoom: Zoom
  /** Whether the image is scaled up (and so pans instead of paging). */
  zoomed: boolean
  /** Back to unzoomed, dropping any gesture under way. */
  reset(): void
  /** For the page the image sits on. */
  handlers: PinchZoomHandlers
  /** For the image; without one, the page stands in for it. */
  imageRef: RefObject<HTMLImageElement | null>
}

const UNZOOMED: Zoom = { scale: 1, x: 0, y: 0 }

/** A scale kept between MIN_ZOOM and MAX_ZOOM. */
export function clampZoom(scale: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale))
}

/** `value` kept within ±`limit`; never -0. */
function within(value: number, limit: number) {
  return Math.min(limit, Math.max(-limit, value)) || 0
}

/**
 * A pan for a `width` x `height` image, centred on a `pageWidth` x
 * `pageHeight` page (by default the image's own size) and scaled by `scale`
 * about its centre: on each axis, at most half of what the scaled image
 * overflows the page by, and 0 where it does not overflow it.
 */
export function clampPan(
  x: number,
  y: number,
  scale: number,
  width: number,
  height: number,
  pageWidth = width,
  pageHeight = height
): { x: number; y: number } {
  return {
    x: within(x, Math.max(0, (scale * width - pageWidth) / 2)),
    y: within(y, Math.max(0, (scale * height - pageHeight) / 2))
  }
}

type Point = { x: number; y: number }

type Pinch = {
  /** At the start: the fingers' distance and midpoint, the scale and pan. */
  dist: number
  mid: Point
  scale: number
  pan: Point
}

type Gesture = {
  /** The fingers down, by pointer id. */
  pointers: Map<number, Point>
  pinch: Pinch | null
  /** A one-finger touch: where it began, and the pan then. */
  touch: { from: Point; pan: Point; tap: boolean } | null
  /** The last tap, for a double tap. */
  lastTap: (Point & { at: number }) | null
}

const point = (e: PointerEvent<HTMLElement>): Point => ({
  x: e.clientX,
  y: e.clientY
})

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** The centre of an element's box on screen. */
function centre(el: HTMLElement): Point {
  const box = el.getBoundingClientRect()
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
}

function newGesture(): Gesture {
  return { pointers: new Map(), pinch: null, touch: null, lastTap: null }
}

export function usePinchZoom(): PinchZoom {
  const [zoom, setZoomState] = useState<Zoom>(UNZOOMED)
  // The latest zoom, for the handlers, which read it between renders.
  const current = useRef(zoom)
  const gesture = useRef<Gesture>(newGesture())
  const imageRef = useRef<HTMLImageElement>(null)
  // The frame that draws the latest zoom, if one is to come.
  const frame = useRef(0)

  const draw = () => {
    frame.current = 0
    setZoomState(current.current)
  }

  /** Draws a pending zoom now, instead of on the next frame. */
  const flush = () => {
    if (!frame.current) return
    cancelAnimationFrame(frame.current)
    draw()
  }

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  /** Zoom to `scale`, the pan kept to the page. Drawn on the next frame. */
  const zoomTo = (page: HTMLElement, scale: number, x: number, y: number) => {
    const image = imageRef.current ?? page
    current.current = {
      scale,
      ...clampPan(
        x,
        y,
        scale,
        image.clientWidth,
        image.clientHeight,
        page.clientWidth,
        page.clientHeight
      )
    }
    if (!frame.current) frame.current = requestAnimationFrame(draw)
  }

  /** A one-finger touch from `from`, at the current pan. */
  const startTouch = (from: Point, tap: boolean) => {
    const { x, y } = current.current
    gesture.current.touch = { from, pan: { x, y }, tap }
  }

  /** A pinch from where the two fingers are now. */
  const startPinch = (g: Gesture) => {
    const [a, b] = [...g.pointers.values()]
    const { scale, x, y } = current.current
    g.pinch = {
      dist: distance(a, b),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      scale,
      pan: { x, y }
    }
  }

  const reset = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
    gesture.current = newGesture()
    current.current = UNZOOMED
    setZoomState(UNZOOMED)
  }, [])

  // A resize (an iPad rotating, or its window changing size) moves the page
  // under a zoomed image, so it unzooms, as Photos does.
  useEffect(() => {
    window.addEventListener('resize', reset)
    window.addEventListener('orientationchange', reset)
    return () => {
      window.removeEventListener('resize', reset)
      window.removeEventListener('orientationchange', reset)
    }
  }, [reset])

  /** A second tap at `at` toggles: in on that point, or back out. */
  const doubleTap = (page: HTMLElement, at: Point) => {
    if (current.current.scale > MIN_ZOOM) {
      current.current = UNZOOMED
    } else {
      // Keep the tapped point under the finger as the image scales about
      // the page's centre.
      const c = centre(page)
      const grow = DOUBLE_TAP_ZOOM - 1
      zoomTo(page, DOUBLE_TAP_ZOOM, -grow * (at.x - c.x), -grow * (at.y - c.y))
    }
    cancelAnimationFrame(frame.current)
    draw()
  }

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (g.pointers.size >= 2) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    g.pointers.set(e.pointerId, point(e))
    if (g.pointers.size === 2) {
      startPinch(g)
      g.touch = null
      return
    }
    startTouch(point(e), true)
  }

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g.pointers.has(e.pointerId)) return
    const at = point(e)
    g.pointers.set(e.pointerId, at)
    const page = e.currentTarget
    const pinch = g.pinch
    if (pinch) {
      if (pinch.dist < PINCH_MIN_SPREAD) {
        // Fingers that landed together: the pinch starts once they part.
        startPinch(g)
        return
      }
      const [a, b] = [...g.pointers.values()]
      const scale = clampZoom((pinch.scale * distance(a, b)) / pinch.dist)
      const k = scale / pinch.scale
      const c = centre(page)
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      // What was under the fingers' midpoint at the start stays under it:
      // the start pan scaled by k, plus the midpoint's travel, less how far
      // the scaling moves the start midpoint from the centre.
      zoomTo(
        page,
        scale,
        pinch.pan.x * k + (mid.x - c.x) - (pinch.mid.x - c.x) * k,
        pinch.pan.y * k + (mid.y - c.y) - (pinch.mid.y - c.y) * k
      )
      return
    }
    const touch = g.touch!
    const dx = at.x - touch.from.x
    const dy = at.y - touch.from.y
    if (Math.hypot(dx, dy) > DOUBLE_TAP_SLOP) touch.tap = false
    const { scale } = current.current
    if (scale > MIN_ZOOM) {
      zoomTo(page, scale, touch.pan.x + dx, touch.pan.y + dy)
    }
  }

  /**
   * A finger lifted, or taken away: by the browser (the strip took the
   * swipe), or by a lost capture (a mouse released off the page). Only a
   * lift can be a tap.
   */
  const lift = (e: PointerEvent<HTMLElement>, tapped: boolean) => {
    const g = gesture.current
    if (!g.pointers.delete(e.pointerId)) return
    flush()
    if (g.pinch) {
      // The finger left pans on from where it is, and is not a tap.
      g.pinch = null
      startTouch([...g.pointers.values()][0], false)
      return
    }
    // With one finger down and no pinch, there is always a touch.
    const touch = g.touch!
    g.touch = null
    if (!tapped || !touch.tap) return
    const at = point(e)
    const now = Date.now()
    const last = g.lastTap
    if (
      last &&
      now - last.at <= DOUBLE_TAP_MS &&
      distance(last, at) <= DOUBLE_TAP_SLOP
    ) {
      g.lastTap = null
      doubleTap(e.currentTarget, at)
      return
    }
    g.lastTap = { ...at, at: now }
  }

  return {
    zoom,
    zoomed: zoom.scale > MIN_ZOOM,
    reset,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: e => lift(e, true),
      onPointerCancel: e => lift(e, false),
      // Only the page's own lost capture: one that bubbles up from inside
      // it is not for a finger the page follows.
      onLostPointerCapture: e => {
        if (e.target === e.currentTarget) lift(e, false)
      }
    },
    imageRef
  }
}
