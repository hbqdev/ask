import { useRef, type PointerEvent } from 'react'

/**
 * The default width, in px, of the left-edge zone the back swipe starts in.
 * Other horizontal gestures (a list row's swipe) leave this zone to it.
 */
export const EDGE_ZONE = 24

/**
 * The speed, in px/ms, at which a short swipe released still moving right
 * counts as a flick and goes back however far it went.
 */
export const FLICK_VELOCITY = 0.5

export type EdgeSwipeOptions = {
  /** How close to the left edge, in px, a drag must start. Default EDGE_ZONE. */
  edge?: number
  /** The fraction of the screen width a drag must pass. Default 0.33. */
  threshold?: number
  /** The release speed, in px/ms, of a flick back. Default FLICK_VELOCITY. */
  flickVelocity?: number
  /** The clock, in ms. Default performance.now. */
  now?: () => number
  /** Called on each move of a swipe with how far it has travelled, in px. */
  onDrag?(dx: number): void
  /** Called when a swipe ends without going back. */
  onCancel?(): void
}

export type EdgeSwipeHandlers = {
  onPointerDown(e: PointerEvent<Element>): void
  onPointerMove(e: PointerEvent<Element>): void
  onPointerUp(e: PointerEvent<Element>): void
  onPointerCancel(e: PointerEvent<Element>): void
}

// How far a pointer moves before the gesture counts as a swipe or a scroll.
const SLOP = 10

// A release this long, in ms, after the last move is a stop, not a flick:
// the finger came to rest before it let go.
const FLICK_HOLD_MS = 100

type Drag = {
  id: number
  x: number
  y: number
  swiping: boolean
  /** The last move: where and when. */
  lastX: number
  lastT: number
  /** The speed of the last move, in px/ms (rightward positive). */
  v: number
}

/** Takes in a move to `x` at `t`: its speed since the last one. */
function sample(d: Drag, x: number, t: number) {
  const dt = t - d.lastT
  // Two moves in one instant say nothing about the speed.
  if (dt <= 0) return
  d.v = (x - d.lastX) / dt
  d.lastX = x
  d.lastT = t
}

/**
 * Pointer handlers for the iOS back gesture: a drag that starts within `edge`
 * px of the left edge and is released past `threshold` of the screen width,
 * or flicked right (a swipe past SLOP released at `flickVelocity` or faster),
 * calls `onBack`. A mostly vertical drag is left to scrolling.
 */
export function useEdgeSwipe(
  onBack: () => void,
  opts: EdgeSwipeOptions = {}
): EdgeSwipeHandlers {
  const {
    edge = EDGE_ZONE,
    threshold = 0.33,
    flickVelocity = FLICK_VELOCITY,
    now = () => performance.now(),
    onDrag,
    onCancel
  } = opts
  const drag = useRef<Drag | null>(null)

  const current = (e: PointerEvent<Element>): Drag | null => {
    const d = drag.current
    return d && d.id === e.pointerId ? d : null
  }

  return {
    onPointerDown(e) {
      if (!e.isPrimary || e.clientX > edge) return
      // React bubbles a press in a portal (a sheet the screen opened) to the
      // screen too; it is not on the screen.
      if (!e.currentTarget.contains(e.target as Node)) return
      drag.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        swiping: false,
        lastX: e.clientX,
        lastT: now(),
        v: 0
      }
    },
    onPointerMove(e) {
      const d = current(e)
      if (!d) return
      sample(d, e.clientX, now())
      const dx = e.clientX - d.x
      if (!d.swiping) {
        const dy = Math.abs(e.clientY - d.y)
        if (dy > SLOP && dy > Math.abs(dx)) {
          drag.current = null
          return
        }
        if (dx <= SLOP) return
        d.swiping = true
        // Keep the moves coming once the finger leaves the element. Only now,
        // so a tap near the edge still reaches its button.
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }
      onDrag?.(Math.max(0, dx))
    },
    onPointerUp(e) {
      const d = current(e)
      if (!d) return
      drag.current = null
      const t = now()
      // A release further on is a last move; one where the last move was,
      // after the finger rested there, ends with no speed.
      if (e.clientX !== d.lastX) sample(d, e.clientX, t)
      else if (t - d.lastT > FLICK_HOLD_MS) d.v = 0
      const dx = e.clientX - d.x
      const flicked = d.swiping && dx > SLOP && d.v >= flickVelocity
      if (dx > threshold * window.innerWidth || flicked) onBack()
      else if (d.swiping) onCancel?.()
    },
    onPointerCancel(e) {
      const d = current(e)
      if (!d) return
      drag.current = null
      if (d.swiping) onCancel?.()
    }
  }
}
