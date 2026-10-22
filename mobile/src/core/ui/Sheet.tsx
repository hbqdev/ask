// A bottom sheet: a modal panel that rises from the bottom edge over a dimmed
// backdrop. A backdrop tap, Escape, or dragging the handle down past
// CLOSE_DRAG closes it. The drag moves the panel with a transform only, so it
// never lays the page out again mid-gesture. Tab stays within the sheet, and
// once closed, focus goes back to what had it when the sheet opened. In dark
// the panel is a raised surface with a hairline top edge, over a deeper dim.
// On an iPad (md, 768 px and up) it is a card centred over the dim, rounded
// and edged all round; its handle still drags it down to close, as an iPad
// form sheet swipes down.

import {
  useEffect,
  useId,
  useRef,
  type PointerEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

import { trapTab, useReturnFocus } from '@/core/ui/focus'

/** How far, in px, the handle must be dragged down to close the sheet. */
export const CLOSE_DRAG = 80

export type SheetProps = {
  open: boolean
  onClose: () => void
  title: string
  /**
   * The id of an element inside that describes the sheet (an explanation
   * read right after the title as the sheet opens).
   */
  describedBy?: string
  children: ReactNode
}

export function Sheet({ open, ...panel }: SheetProps) {
  if (!open) return null
  return <SheetPanel {...panel} />
}

type Drag = { id: number; y: number; dy: number }

function SheetPanel({
  onClose,
  title,
  describedBy,
  children
}: Omit<SheetProps, 'open'>) {
  // On close, focus goes back to what opened the sheet.
  useReturnFocus()
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  // The latest onClose, so the key listener isn't re-added on each render.
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    // Into the dialog, unless a field inside already took focus (autoFocus).
    if (!panel.current?.contains(document.activeElement)) {
      panel.current?.focus()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const current = (e: PointerEvent<Element>) => {
    const d = drag.current
    return d && d.id === e.pointerId ? d : null
  }

  // Inline styles drive the drag; clearing them hands the panel back to its
  // stylesheet, whose transition settles it.
  const settle = () => {
    drag.current = null
    const el = panel.current!
    el.style.transform = ''
    el.style.transition = ''
  }

  const handlers = {
    onPointerDown(e: PointerEvent<HTMLDivElement>) {
      drag.current = { id: e.pointerId, y: e.clientY, dy: 0 }
      e.currentTarget.setPointerCapture?.(e.pointerId)
      panel.current!.style.transition = 'none'
    },
    onPointerMove(e: PointerEvent<HTMLDivElement>) {
      const d = current(e)
      if (!d) return
      d.dy = Math.max(0, e.clientY - d.y)
      panel.current!.style.transform = `translate3d(0, ${d.dy}px, 0)`
    },
    onPointerUp(e: PointerEvent<HTMLDivElement>) {
      const d = current(e)
      if (!d) return
      settle()
      if (d.dy >= CLOSE_DRAG) onClose()
    },
    onPointerCancel(e: PointerEvent<HTMLDivElement>) {
      if (current(e)) settle()
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end md:items-center md:justify-center md:p-6">
      <div
        data-testid="sheet-backdrop"
        aria-hidden="true"
        className="sheet-backdrop absolute inset-0 bg-black/40 dark:bg-black/60"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={e => {
          // React bubbles a key from a sheet opened over this one (another
          // portal) through here too: that sheet keeps its own Tab.
          if (panel.current!.contains(e.target as Node)) {
            trapTab(e.nativeEvent, panel.current!)
          }
        }}
        className="sheet-panel relative flex max-h-[85vh] flex-col rounded-t-3xl bg-elevated text-foreground shadow-2xl outline-none dark:border-t dark:border-foreground/10 md:max-h-[80vh] md:w-full md:max-w-lg md:rounded-3xl md:dark:border"
      >
        <div
          data-testid="sheet-handle"
          className="flex shrink-0 touch-none justify-center pt-2 pb-1"
          {...handlers}
        >
          <div className="h-1.5 w-10 rounded-full bg-foreground/20" />
        </div>
        <h2
          id={titleId}
          className="shrink-0 px-6 pb-3 text-lg font-semibold tracking-tight"
        >
          {title}
        </h2>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-4">
          {children}
        </div>
      </div>
    </div>,
    document.body
  )
}
