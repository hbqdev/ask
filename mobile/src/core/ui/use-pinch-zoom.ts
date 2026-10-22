// Pinch and double-tap zoom for one image, as the image viewer's own gesture:
// the page itself never zooms (index.html, styles.css). Two fingers scale the
// image from the scale it was at; one finger pans it while it is zoomed; a
// second tap soon after the first, in about the same place, zooms in on that
// point or back out. The hook only reports the zoom: the image moves itself
// with `translate(x px, y px) scale(scale)` about its centre, and the pan is
// kept so its edges never come inside its own box.
//
// Pointer events, on the image: while it is unzoomed it is `touch-action:
// pan-x`, so a one-finger swipe still pages the viewer's strip (the browser
// takes the pan, and cancels the pointer); zoomed it is `touch-action: none`
// and every touch comes here.

import { useCallback, useRef, useState, type PointerEvent } from 'react'

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

export type Zoom = { scale: number; x: number; y: number }

export type PinchZoomHandlers = {
  onPointerDown(e: PointerEvent<HTMLElement>): void
  onPointerMove(e: PointerEvent<HTMLElement>): void
  onPointerUp(e: PointerEvent<HTMLElement>): void
  onPointerCancel(e: PointerEvent<HTMLElement>): void
}

export type PinchZoom = {
  zoom: Zoom
  /** Whether the image is scaled up (and so pans instead of paging). */
  zoomed: boolean
  /** Back to unzoomed, dropping any gesture under way. */
  reset(): void
  handlers: PinchZoomHandlers
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
 * A pan kept so a `width` x `height` image scaled by `scale` about its centre
 * still covers its own box: at most (scale - 1) half-sizes either way.
 */
export function clampPan(
  x: number,
  y: number,
  scale: number,
  width: number,
  height: number
): { x: number; y: number } {
  return {
    x: within(x, ((scale - 1) * width) / 2),
    y: within(y, ((scale - 1) * height) / 2)
  }
}

type Point = { x: number; y: number }

type Gesture = {
  /** The fingers down, by pointer id. */
  pointers: Map<number, Point>
  /** A pinch: the fingers' distance and the scale when it began. */
  pinch: { dist: number; scale: number } | null
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

function newGesture(): Gesture {
  return { pointers: new Map(), pinch: null, touch: null, lastTap: null }
}

export function usePinchZoom(): PinchZoom {
  const [zoom, setZoomState] = useState<Zoom>(UNZOOMED)
  // The latest zoom, for the handlers, which read it between renders.
  const current = useRef(zoom)
  const gesture = useRef<Gesture>(newGesture())

  const setZoom = (next: Zoom) => {
    current.current = next
    setZoomState(next)
  }

  /** Zoom to `scale`, the pan kept inside the image's (unscaled) box. */
  const zoomTo = (el: HTMLElement, scale: number, x: number, y: number) => {
    setZoom({
      scale,
      ...clampPan(x, y, scale, el.clientWidth, el.clientHeight)
    })
  }

  /** A one-finger touch from `from`, at the current pan. */
  const startTouch = (from: Point, tap: boolean) => {
    const { x, y } = current.current
    gesture.current.touch = { from, pan: { x, y }, tap }
  }

  const reset = useCallback(() => {
    gesture.current = newGesture()
    current.current = UNZOOMED
    setZoomState(UNZOOMED)
  }, [])

  /** A second tap at `at` toggles: in on that point, or back out. */
  const doubleTap = (el: HTMLElement, at: Point) => {
    if (current.current.scale > MIN_ZOOM) {
      setZoom(UNZOOMED)
      return
    }
    // The box's centre on screen; unzoomed, the box is where it is drawn.
    const box = el.getBoundingClientRect()
    const dx = at.x - (box.left + box.width / 2)
    const dy = at.y - (box.top + box.height / 2)
    // Keep the tapped point under the finger as the image scales about its
    // centre.
    const grow = DOUBLE_TAP_ZOOM - 1
    zoomTo(el, DOUBLE_TAP_ZOOM, -grow * dx, -grow * dy)
  }

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (g.pointers.size >= 2) return
    g.pointers.set(e.pointerId, point(e))
    if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()]
      g.pinch = { dist: distance(a, b), scale: current.current.scale }
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
    const el = e.currentTarget
    if (g.pinch) {
      const [a, b] = [...g.pointers.values()]
      // Two fingers on one spot spread nothing.
      const spread = distance(a, b) / Math.max(1, g.pinch.dist)
      const { x, y } = current.current
      zoomTo(el, clampZoom(g.pinch.scale * spread), x, y)
      return
    }
    const touch = g.touch!
    const dx = at.x - touch.from.x
    const dy = at.y - touch.from.y
    if (Math.hypot(dx, dy) > DOUBLE_TAP_SLOP) touch.tap = false
    const { scale } = current.current
    if (scale > MIN_ZOOM) zoomTo(el, scale, touch.pan.x + dx, touch.pan.y + dy)
  }

  /** A finger lifted, or taken by the browser (`tapped` false). */
  const lift = (e: PointerEvent<HTMLElement>, tapped: boolean) => {
    const g = gesture.current
    if (!g.pointers.delete(e.pointerId)) return
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
      onPointerCancel: e => lift(e, false)
    }
  }
}
