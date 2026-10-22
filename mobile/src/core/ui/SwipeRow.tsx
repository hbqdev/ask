// A list row with iOS swipe actions. Dragging the row left reveals its action
// buttons; released past OPEN_AT it snaps open, short of it it snaps back. A
// full swipe past FULL_SWIPE of the row's width runs the first action. Only
// one row is open at a time, and a tap anywhere else closes it and does
// nothing more (as in iOS Mail: that tap is swallowed).
//
// The row moves with a transform only. It sets `touch-action: pan-y`, so a
// vertical drag stays a native scroll (the browser cancels the pointer), and
// it leaves drags that start in the stack's back-swipe edge zone alone.
//
// Haptics: a selection tick each time a drag crosses OPEN_AT (once going
// past it, once more coming back, never on every move), and a light tap when
// an action runs, by a full swipe or its button. Even Delete taps light: the
// warning belongs to the point of no return, its confirmation (ConfirmSheet).

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode
} from 'react'

import { haptic } from '@/core/haptics'
import { EDGE_ZONE } from '@/core/nav/use-edge-swipe'

export type SwipeAction = {
  label: string
  tone?: 'destructive'
  onAction(): void
}

export type SwipeRowProps = {
  children: ReactNode
  actions: SwipeAction[]
  onPress(): void
}

/** The width, in px, of each action button. */
export const ACTION_WIDTH = 80
/** How far, in px, a row must be dragged open to stay open. */
export const OPEN_AT = 72
/** The fraction of the row's width a full swipe must pass. */
export const FULL_SWIPE = 0.6
// How far a pointer moves before the gesture counts as a swipe or a scroll.
const SLOP = 10

// The registry: the one open (or opening) row, and the document listener
// that closes it on a press anywhere outside it.
type OpenRow = { el: HTMLElement; close(): void }
let openRow: OpenRow | null = null

function closeOnOutsidePress(e: Event) {
  if (!openRow || openRow.el.contains(e.target as Node)) return
  openRow.close()
  swallowNextClick()
}

// The click that ends the closing press is stopped (in the capture phase on
// the document, before it reaches anything), so it presses nothing. Should
// that press make no click (it became a scroll), the next press, any key or
// SWALLOW_MS disarms it: a screen reader or keyboard activates with a click
// and no press, and that click must not be eaten.
const SWALLOW_MS = 600
let disarmTimer: ReturnType<typeof setTimeout> | undefined

function swallowNextClick() {
  document.addEventListener('click', swallow, true)
  document.addEventListener('pointerdown', disarm, true)
  document.addEventListener('keydown', disarm, true)
  clearTimeout(disarmTimer)
  disarmTimer = setTimeout(disarm, SWALLOW_MS)
}

function swallow(e: Event) {
  e.stopPropagation()
  e.preventDefault()
  disarm()
}

function disarm() {
  clearTimeout(disarmTimer)
  document.removeEventListener('click', swallow, true)
  document.removeEventListener('pointerdown', disarm, true)
  document.removeEventListener('keydown', disarm, true)
}

/** Makes `row` the open row, closing any other. */
function claimOpen(row: OpenRow) {
  if (openRow === row) return
  openRow?.close()
  openRow = row
  document.addEventListener('pointerdown', closeOnOutsidePress, true)
}

function releaseOpen(row: OpenRow) {
  if (openRow !== row) return
  openRow = null
  document.removeEventListener('pointerdown', closeOnOutsidePress, true)
}

const ACTION_COLOURS = {
  destructive: 'bg-red-500 text-white',
  plain: 'bg-muted-foreground text-background'
}

type Drag = {
  id: number
  x: number
  y: number
  from: number
  pos: number
  /** The row is past OPEN_AT (it would stay open if released now). */
  past: boolean
}

const pastOpen = (pos: number) => -pos > OPEN_AT

/** Runs a swipe action, with its haptic. */
function run(action: SwipeAction) {
  haptic('light')
  action.onAction()
}

export function SwipeRow({ children, actions, onPress }: SwipeRowProps) {
  const root = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const swiping = useRef(false)
  // Set when a press turned into a swipe, so its trailing click is dropped.
  const swiped = useRef(false)
  const [open, setOpen] = useState(false)
  const openWidth = actions.length * ACTION_WIDTH

  // This row in the registry, created once: the registry compares by identity.
  const [handle] = useState<OpenRow>(() => ({
    get el() {
      return root.current!
    },
    close: () => settle(0)
  }))

  // Leaves the row at `pos` (0 = closed), animated by the stylesheet.
  function settle(pos: number) {
    drag.current = null
    swiping.current = false
    // Only a mounted row is ever settled: it leaves the registry on unmount.
    const el = content.current!
    el.style.transition = ''
    el.style.transform = pos ? `translate3d(${pos}px, 0, 0)` : ''
    setOpen(pos !== 0)
    if (pos) claimOpen(handle)
    else releaseOpen(handle)
  }

  useEffect(() => () => releaseOpen(handle), [handle])

  const current = (e: PointerEvent<Element>) => {
    const d = drag.current
    return d && d.id === e.pointerId ? d : null
  }

  const handlers = {
    onPointerDown(e: PointerEvent<HTMLDivElement>) {
      swiped.current = false
      if (!e.isPrimary || e.clientX <= EDGE_ZONE) return
      const from = open ? -openWidth : 0
      drag.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        from,
        pos: from,
        past: pastOpen(from)
      }
    },
    onPointerMove(e: PointerEvent<HTMLDivElement>) {
      const d = current(e)
      if (!d) return
      const dx = e.clientX - d.x
      if (!swiping.current) {
        const dy = Math.abs(e.clientY - d.y)
        if (dy > SLOP && dy > Math.abs(dx)) {
          drag.current = null
          return
        }
        // Closed, only a left drag opens it; open, either way moves it.
        if (Math.abs(dx) <= SLOP || (dx > 0 && !d.from)) return
        swiping.current = true
        swiped.current = true
        e.currentTarget.setPointerCapture?.(e.pointerId)
        claimOpen(handle)
        content.current!.style.transition = 'none'
      }
      const width = root.current!.clientWidth
      d.pos = Math.min(0, d.from + dx)
      if (width > 0) d.pos = Math.max(-width, d.pos)
      content.current!.style.transform = `translate3d(${d.pos}px, 0, 0)`
      if (pastOpen(d.pos) !== d.past) {
        d.past = !d.past
        haptic('selection')
      }
    },
    onPointerUp(e: PointerEvent<HTMLDivElement>) {
      const d = current(e)
      if (!d) return
      if (!swiping.current) {
        drag.current = null
        return
      }
      const width = root.current!.clientWidth
      if (width > 0 && -d.pos > FULL_SWIPE * width) {
        settle(0)
        if (actions[0]) run(actions[0])
      } else {
        settle(d.past ? -openWidth : 0)
      }
    },
    onPointerCancel(e: PointerEvent<HTMLDivElement>) {
      const d = current(e)
      if (!d) return
      if (swiping.current) settle(d.from)
      else drag.current = null
    }
  }

  // A tap on an open row closes it; on a closed one it presses.
  const activate = () => {
    if (open) settle(0)
    else onPress()
  }

  const onClick = () => {
    if (swiped.current) swiped.current = false
    else activate()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    activate()
  }

  const first = actions[0]
  return (
    <div
      ref={root}
      className={`swipe-row relative overflow-hidden ${
        // Past the buttons, a full swipe shows the first action's colour.
        first ? ACTION_COLOURS[first.tone ?? 'plain'] : ''
      }`}
    >
      <div
        data-swipe-actions=""
        inert={!open}
        className="absolute inset-y-0 right-0 flex"
      >
        {actions.map(action => (
          <button
            key={action.label}
            type="button"
            onClick={() => {
              settle(0)
              run(action)
            }}
            style={{ width: ACTION_WIDTH }}
            className={`flex touch-manipulation items-center justify-center text-sm font-medium active:opacity-60 ${
              ACTION_COLOURS[action.tone ?? 'plain']
            }`}
          >
            {action.label}
          </button>
        ))}
      </div>
      <div
        ref={content}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className="swipe-row-content relative bg-background text-foreground active:bg-muted"
        {...handlers}
      >
        {children}
      </div>
    </div>
  )
}
