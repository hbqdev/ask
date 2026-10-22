// Pull to refresh for a scrolling list. A drag down that starts with the list
// at its top pulls it (damped, so it gives less the further it goes);
// released at `threshold` or more it calls `onRefresh`, and `refreshing`
// holds until that settles. The hook only reports `pull`, in px: the screen
// moves its list (and spinner) with a transform.
//
// Touch events, not pointer events: on iOS a vertical drag on a scroller is a
// native pan, and the browser cancels the pointer as the pan starts
// (pointercancel), so a pointer-driven pull would never see the drag. Touch
// events keep coming, and a non-passive touchmove can hold the native scroll
// still while the pull runs.

import { useEffect, useRef, useState, type RefObject } from 'react'

import { haptic } from '@/core/haptics'

export type PullToRefreshOptions = {
  /** How far, in px, the (damped) pull must reach to refresh. Default 64. */
  threshold?: number
}

export type PullToRefresh = {
  /** How far the list is pulled down, in px; `threshold` while refreshing. */
  pull: number
  refreshing: boolean
}

// How far a finger moves before the gesture counts as a pull or a scroll.
const SLOP = 10

type Drag = { id: number; x: number; y: number; pulling: boolean }

/**
 * The damped pull for a finger travel of `dy` px: close to `dy` at first, it
 * approaches `limit` but never reaches it.
 */
function damp(dy: number, limit: number) {
  return (dy * limit) / (dy + limit)
}

export function usePullToRefresh(
  ref: RefObject<HTMLElement | null>,
  onRefresh: () => Promise<void>,
  { threshold = 64 }: PullToRefreshOptions = {}
): PullToRefresh {
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  // The latest values, for the listeners added once.
  const latest = useRef({ onRefresh, threshold, refreshing })
  latest.current = { onRefresh, threshold, refreshing }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let drag: Drag | null = null
    let distance = 0

    const find = (e: TouchEvent) =>
      drag
        ? Array.from(e.changedTouches).find(t => t.identifier === drag!.id)
        : undefined

    const onStart = (e: TouchEvent) => {
      drag = null
      if (latest.current.refreshing || e.touches.length !== 1) return
      if (el.scrollTop > 0) return
      const t = e.touches[0]
      drag = { id: t.identifier, x: t.clientX, y: t.clientY, pulling: false }
    }

    const onMove = (e: TouchEvent) => {
      const t = find(e)
      if (!drag || !t) return
      const dy = t.clientY - drag.y
      if (!drag.pulling) {
        const dx = Math.abs(t.clientX - drag.x)
        // Scrolled away, a drag up, or a sideways drag: not a pull.
        if (el.scrollTop > 0 || dy < -SLOP || (dx > SLOP && dx >= dy)) {
          drag = null
          return
        }
        if (dy <= SLOP) return
        drag.pulling = true
      }
      if (e.cancelable) e.preventDefault()
      distance = damp(Math.max(0, dy), 2 * latest.current.threshold)
      setPull(distance)
    }

    const onEnd = (e: TouchEvent) => {
      if (!find(e)) return
      const pulled = drag!.pulling ? distance : 0
      drag = null
      distance = 0
      const { threshold, onRefresh } = latest.current
      if (e.type === 'touchend' && pulled >= threshold) {
        haptic('medium')
        setPull(threshold)
        setRefreshing(true)
        latest.current.refreshing = true
        const done = () => {
          setRefreshing(false)
          setPull(0)
        }
        // A failed refresh is the caller's to report; the pull just ends.
        onRefresh().then(done, done)
      } else {
        setPull(0)
      }
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [ref])

  return { pull, refreshing }
}
