import { useRef, type PointerEvent } from 'react'

/**
 * The default width, in px, of the left-edge zone the back swipe starts in.
 * Other horizontal gestures (a list row's swipe) leave this zone to it.
 */
export const EDGE_ZONE = 24

export type EdgeSwipeOptions = {
  /** How close to the left edge, in px, a drag must start. Default EDGE_ZONE. */
  edge?: number
  /** The fraction of the screen width a drag must pass. Default 0.33. */
  threshold?: number
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

type Drag = { id: number; x: number; y: number; swiping: boolean }

/**
 * Pointer handlers for the iOS back gesture: a drag that starts within `edge`
 * px of the left edge and is released past `threshold` of the screen width
 * calls `onBack`. A mostly vertical drag is left to scrolling.
 */
export function useEdgeSwipe(
  onBack: () => void,
  opts: EdgeSwipeOptions = {}
): EdgeSwipeHandlers {
  const { edge = EDGE_ZONE, threshold = 0.33, onDrag, onCancel } = opts
  const drag = useRef<Drag | null>(null)

  const current = (e: PointerEvent<Element>): Drag | null => {
    const d = drag.current
    return d && d.id === e.pointerId ? d : null
  }

  return {
    onPointerDown(e) {
      if (!e.isPrimary || e.clientX > edge) return
      drag.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        swiping: false
      }
    },
    onPointerMove(e) {
      const d = current(e)
      if (!d) return
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
      if (e.clientX - d.x > threshold * window.innerWidth) onBack()
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
