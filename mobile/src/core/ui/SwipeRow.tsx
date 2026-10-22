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
// Colour: the first action's colour fills the row behind its content (so a
// full swipe, past the buttons, shows it) only while the row is exposed: from
// the start of a swipe until it has settled closed, its slide back included.
// At rest nothing is painted there and the buttons are hidden, so no colour
// bleeds at a rounded corner.
//
// Haptics: a selection tick each time a drag crosses OPEN_AT (once going
// past it, once more coming back, never on every move), and a light tap when
// an action runs, by a full swipe or its button. Even Delete taps light: the
// warning belongs to the point of no return, its confirmation (ConfirmSheet).
//
// Without swiping: a press held still for LONG_PRESS_MS (or a contextmenu
// event: a right click, Android's long press) opens the actions in a sheet,
// with a medium tap. That is the way for VoiceOver, which the row tells
// about in its description. The row itself stays at rest, its colour and
// buttons unshown. Nothing in a row is selectable, so iOS shows no text
// selection or callout for the press (the page's chrome: styles.css).

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type TransitionEvent
} from 'react'

import { flushSync } from 'react-dom'

import { haptic } from '@/core/haptics'
import { EDGE_ZONE } from '@/core/nav/use-edge-swipe'
import { Sheet } from '@/core/ui/Sheet'

export type SwipeAction = {
  label: string
  tone?: 'destructive'
  onAction(): void
}

export type SwipeRowProps = {
  children: ReactNode
  actions: SwipeAction[]
  onPress(): void
  /**
   * What the row sits on, which its content is painted with: the page
   * (default), or a grouped card's tint.
   */
  surface?: 'page' | 'card'
  /** The title of the sheet a long press opens. Default 'Actions'. */
  actionsTitle?: string
}

/** The width, in px, of each action button. */
export const ACTION_WIDTH = 80
/** How far, in px, a row must be dragged open to stay open. */
export const OPEN_AT = 72
/** The fraction of the row's width a full swipe must pass. */
export const FULL_SWIPE = 0.6
/** How long, in ms, a press held still opens the row's actions sheet. */
export const LONG_PRESS_MS = 500
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
  destructive: 'bg-red-600 text-white',
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

// The content's colour, and pressed, a step off it. In dark, muted is the
// card's own lightness, so a card row presses to the thumb instead.
const SURFACES = {
  page: 'bg-background active:bg-muted',
  card: 'bg-card active:bg-muted dark:active:bg-thumb'
}

/**
 * How long, in ms, the stylesheet's settle transition takes on this element
 * (0 with reduced motion). Computed durations are in seconds.
 */
const slideMs = (el: HTMLElement) =>
  (parseFloat(getComputedStyle(el).transitionDuration) || 0) * 1000

// Past a slide's time, a closed row is covered even if no transition event
// came (a close and a hide in one style recalc make no transition at all).
const SLIDE_GRACE_MS = 50

/** Runs a swipe action, with its haptic. */
function run(action: SwipeAction) {
  haptic('light')
  action.onAction()
}

// A press that may become a long press: where it went down.
type Hold = { id: number; x: number; y: number }

// The actions sheet's buttons: ConfirmSheet's.
const SHEET_BUTTON =
  'min-h-12 w-full touch-manipulation rounded-xl bg-muted text-base font-medium active:opacity-50'

export function SwipeRow({
  children,
  actions,
  onPress,
  surface = 'page',
  actionsTitle = 'Actions'
}: SwipeRowProps) {
  const root = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const swiping = useRef(false)
  // Set when a press turned into a swipe, so its trailing click is dropped.
  const swiped = useRef(false)
  const [open, setOpen] = useState(false)
  // The row is swiping, open, or sliding closed: its colour shows.
  const [exposed, setExposed] = useState(false)
  // Where the content was last put (0 = closed), to know if a settle moves it.
  const at = useRef(0)
  // Covers a closed row once its slide's time is up (the fallback for a
  // missing transition event).
  const coverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const openWidth = actions.length * ACTION_WIDTH
  // The long press: the press being held, its timer, and whether it fired
  // (so the click its release makes is swallowed).
  const hold = useRef<Hold | null>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const held = useRef(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const hintId = useId()

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
    const moved = at.current !== pos
    at.current = pos
    setOpen(pos !== 0)
    if (pos) {
      claimOpen(handle)
    } else {
      releaseOpen(handle)
      // Closed where it already was, or without a slide: covered at once.
      // Otherwise the colour stays until the slide ends (onTransitionEnd),
      // or its time is up.
      const ms = moved ? slideMs(el) : 0
      if (ms > 0) {
        clearTimeout(coverTimer.current)
        coverTimer.current = setTimeout(() => {
          if (at.current === 0) setExposed(false)
        }, ms + SLIDE_GRACE_MS)
      } else {
        setExposed(false)
      }
    }
  }

  useEffect(
    () => () => {
      releaseOpen(handle)
      clearTimeout(coverTimer.current)
      clearTimeout(holdTimer.current)
    },
    [handle]
  )

  const cancelHold = () => {
    clearTimeout(holdTimer.current)
    hold.current = null
  }

  const showActions = () => {
    haptic('medium')
    setSheetOpen(true)
  }

  // Held long enough: the actions open, and the finger moving on from here
  // swipes nothing.
  const onHeld = () => {
    hold.current = null
    drag.current = null
    held.current = true
    showActions()
  }

  // The sheet goes first, so focus is back on the row (Sheet's return) before
  // the action opens anything of its own (a confirmation).
  const choose = (action: SwipeAction) => {
    flushSync(() => setSheetOpen(false))
    run(action)
  }

  const current = (e: PointerEvent<Element>) => {
    const d = drag.current
    return d && d.id === e.pointerId ? d : null
  }

  const handlers = {
    onPointerDown(e: PointerEvent<HTMLDivElement>) {
      swiped.current = false
      held.current = false
      // The edge zone is the stack's back swipe, held or dragged.
      if (!e.isPrimary || e.clientX <= EDGE_ZONE) return
      // An open row's press is a tap that closes it.
      if (actions.length > 0 && !open) {
        hold.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
        clearTimeout(holdTimer.current)
        holdTimer.current = setTimeout(onHeld, LONG_PRESS_MS)
      }
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
      const h = hold.current
      if (
        h?.id === e.pointerId &&
        Math.hypot(e.clientX - h.x, e.clientY - h.y) > SLOP
      ) {
        cancelHold()
      }
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
        clearTimeout(coverTimer.current)
        setExposed(true)
        content.current!.style.transition = 'none'
      }
      const width = root.current!.clientWidth
      d.pos = Math.min(0, d.from + dx)
      if (width > 0) d.pos = Math.max(-width, d.pos)
      at.current = d.pos
      content.current!.style.transform = `translate3d(${d.pos}px, 0, 0)`
      if (pastOpen(d.pos) !== d.past) {
        d.past = !d.past
        haptic('selection')
      }
    },
    onPointerUp(e: PointerEvent<HTMLDivElement>) {
      cancelHold()
      // The click this release makes would press the row, or land on the
      // sheet's backdrop and close it: it is swallowed wherever it lands.
      if (held.current) {
        held.current = false
        swallowNextClick()
      }
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
      cancelHold()
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

  // A right click, or a long press where the browser makes one (Android):
  // the actions, not the browser's menu. After the long press opened them,
  // nothing more. Made during a press, it ends that press as a long press
  // would: its click is swallowed and the finger swipes nothing.
  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    if (actions.length === 0) return
    e.preventDefault()
    if (hold.current) {
      held.current = true
      drag.current = null
    }
    cancelHold()
    if (!sheetOpen) showActions()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    activate()
  }

  // The content's own slide closed has ended (or was cut short, as by the
  // screen going away): nothing shows behind it now. A new drag that cuts it
  // short has moved the content off 0 and exposed the row again.
  // Only the transform's: another property's transition (a colour) is not
  // the slide. Read from the native event: React's synthetic event for
  // transitioncancel carries no propertyName.
  const onTransitionEnd = (e: TransitionEvent<HTMLDivElement>) => {
    if (
      e.target === e.currentTarget &&
      e.nativeEvent.propertyName === 'transform' &&
      at.current === 0
    ) {
      setExposed(false)
    }
  }

  const first = actions[0]
  return (
    <div
      ref={root}
      className={`swipe-row relative overflow-hidden ${
        // Past the buttons, a full swipe shows the first action's colour.
        exposed && first ? ACTION_COLOURS[first.tone ?? 'plain'] : ''
      }`}
    >
      <div
        data-swipe-actions=""
        inert={!open}
        // Hidden at rest too, so a rounded card's corner shows none of the
        // buttons' colour at its anti-aliased edge.
        className={`absolute inset-y-0 right-0 flex ${exposed ? '' : 'invisible'}`}
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
        aria-describedby={actions.length > 0 ? hintId : undefined}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        onTransitionEnd={onTransitionEnd}
        onTransitionCancel={onTransitionEnd}
        className={`swipe-row-content relative ${SURFACES[surface]} text-foreground`}
        {...handlers}
      >
        {children}
      </div>
      {actions.length > 0 && (
        <span id={hintId} className="sr-only">
          {`Touch and hold for ${actions.map(a => a.label).join(', ')}.`}
        </span>
      )}
      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={actionsTitle}
      >
        <div className="flex flex-col gap-2 pb-2">
          {actions.map(action => (
            <button
              key={action.label}
              type="button"
              onClick={() => choose(action)}
              className={`${SHEET_BUTTON} ${
                action.tone === 'destructive'
                  ? 'text-destructive'
                  : 'text-foreground'
              }`}
            >
              {action.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setSheetOpen(false)}
            className={`${SHEET_BUTTON} text-foreground`}
          >
            Cancel
          </button>
        </div>
      </Sheet>
    </div>
  )
}
