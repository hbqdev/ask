import { useCallback, useRef, type PointerEvent } from 'react'

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
  /**
   * A clock, in ms, to time the events by instead of their own timeStamp
   * (for tests).
   */
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

export type EdgeSwipe = EdgeSwipeHandlers & {
  /** Drops the drag in progress (the screen it was on changed under it). */
  cancel(): void
}

// How far a pointer moves before the gesture counts as a swipe or a scroll.
const SLOP = 10

// A flick's speed is measured over the moves of the last FLICK_WINDOW_MS
// before the release (since the finger last turned back right), and only
// over at least FLICK_MIN_SPAN_MS: a 1 ms release jitter, or moves flushed
// together after a stall, say nothing about the speed. A finger that rested
// for the whole window before letting go has none.
const FLICK_WINDOW_MS = 50
const FLICK_MIN_SPAN_MS = 4

type Sample = { x: number; t: number }

type Drag = {
  id: number
  x: number
  y: number
  swiping: boolean
  /** Where the pointer was and when, the window's worth (oldest first). */
  samples: Sample[]
}

/** Records a move, dropping samples older than the window. */
function record(d: Drag, x: number, t: number) {
  d.samples.push({ x, t })
  while (d.samples[0].t < t - FLICK_WINDOW_MS) d.samples.shift()
}

/** The speed, in px/ms, rightward, of the latest run of moves right. */
function velocity(samples: Sample[]): number {
  const end = samples[samples.length - 1]
  let i = samples.length - 1
  while (i > 0 && samples[i - 1].x <= samples[i].x) i--
  const span = end.t - samples[i].t
  return span >= FLICK_MIN_SPAN_MS ? (end.x - samples[i].x) / span : 0
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
): EdgeSwipe {
  const {
    edge = EDGE_ZONE,
    threshold = 0.33,
    flickVelocity = FLICK_VELOCITY,
    now,
    onDrag,
    onCancel
  } = opts
  const drag = useRef<Drag | null>(null)
  // Stable, for effects to depend on.
  const cancel = useCallback(() => {
    drag.current = null
  }, [])
  // Each event's own time: when the touch happened, not when a busy main
  // thread got round to handling it.
  const time = (e: PointerEvent<Element>) => (now ? now() : e.timeStamp)

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
        samples: [{ x: e.clientX, t: time(e) }]
      }
    },
    onPointerMove(e) {
      const d = current(e)
      if (!d) return
      record(d, e.clientX, time(e))
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
      record(d, e.clientX, time(e))
      const dx = e.clientX - d.x
      const flicked =
        d.swiping && dx > SLOP && velocity(d.samples) >= flickVelocity
      if (dx > threshold * window.innerWidth || flicked) onBack()
      else if (d.swiping) onCancel?.()
    },
    onPointerCancel(e) {
      const d = current(e)
      if (!d) return
      drag.current = null
      if (d.swiping) onCancel?.()
    },
    cancel
  }
}
