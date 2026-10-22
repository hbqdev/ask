import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { scrollActiveToTop } from '@/core/nav/scroll-to-top'
import { Sheet } from '@/core/ui/Sheet'

function setup(open = true) {
  const onClose = vi.fn()
  const view = render(
    <Sheet open={open} onClose={onClose} title="Options">
      <p>Sheet body</p>
    </Sheet>
  )
  return { onClose, ...view }
}

type Point = { y: number; id?: number }

function at({ y, id = 1 }: Point) {
  return { clientX: 50, clientY: y, pointerId: id, isPrimary: true }
}

/** A drag on the handle along the given points: down at the first, up at the last. */
function drag(points: Point[]) {
  const handle = screen.getByTestId('sheet-handle')
  fireEvent.pointerDown(handle, at(points[0]))
  for (const p of points.slice(1)) fireEvent.pointerMove(handle, at(p))
  fireEvent.pointerUp(handle, at(points[points.length - 1]))
}

const panel = () => screen.getByRole('dialog')

describe('Sheet', () => {
  it('rises on the elevated surface, edged in dark, over a deeper dim in dark', () => {
    setup()
    expect(panel()).toHaveClass('bg-elevated', 'dark:border-t')
    expect(panel()).toHaveClass('dark:border-foreground/10')
    expect(panel()).not.toHaveClass('bg-background')
    expect(screen.getByTestId('sheet-backdrop')).toHaveClass(
      'bg-black/40',
      'dark:bg-black/60'
    )
  })

  it('at md (iPad) is a centred card, rounded all round, not a bottom sheet', () => {
    setup()
    // The wrapper centres it with a margin from every edge.
    expect(panel().parentElement).toHaveClass(
      'justify-end',
      'md:items-center',
      'md:justify-center',
      'md:p-6'
    )
    expect(panel()).toHaveClass(
      'rounded-t-3xl',
      'md:w-full',
      'md:max-w-lg',
      'md:rounded-3xl',
      'md:max-h-[80vh]'
    )
    // In dark, a floating card is edged all round, not only along its top.
    expect(panel()).toHaveClass('md:dark:border')
  })

  it('at md keeps its handle, so a drag down still closes the card', () => {
    // An iPad form sheet also closes with a swipe down.
    const { onClose } = setup()
    expect(screen.getByTestId('sheet-handle')).not.toHaveClass('md:hidden')
    drag([{ y: 100 }, { y: 200 }])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('takes a status-bar tap on its own list, leaving the screen behind where it was', () => {
    render(
      <div className="stack-layer">
        <div data-testid="thread-scroll" data-scroll-root />
        <Sheet open onClose={vi.fn()} title="Sources">
          <p>Sheet body</p>
        </Sheet>
      </div>
    )
    const thread = screen.getByTestId('thread-scroll')
    const list = screen.getByText('Sheet body').parentElement!
    thread.scrollTo = vi.fn() as unknown as HTMLElement['scrollTo']
    list.scrollTo = vi.fn() as unknown as HTMLElement['scrollTo']
    expect(list).toHaveAttribute('data-scroll-root')
    expect(scrollActiveToTop()).toBe(true)
    expect(list.scrollTo).toHaveBeenCalledTimes(1)
    expect(thread.scrollTo).not.toHaveBeenCalled()
  })

  it('renders nothing when closed', () => {
    setup(false)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('Sheet body')).toBeNull()
  })

  it('renders a modal dialog named by its title, in a portal on the body', () => {
    const { container } = setup()
    const dialog = panel()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName('Options')
    expect(screen.getByText('Sheet body')).toBeInTheDocument()
    expect(container).not.toContainElement(dialog)
    expect(document.body).toContainElement(dialog)
  })

  it('is described by the element describedBy names', () => {
    render(
      <Sheet open onClose={vi.fn()} title="Delete account?" describedBy="why">
        <p id="why">Everything is deleted.</p>
      </Sheet>
    )
    expect(panel()).toHaveAttribute('aria-describedby', 'why')
    expect(panel()).toHaveAccessibleDescription('Everything is deleted.')
  })

  it('has no description without describedBy', () => {
    setup()
    expect(panel()).not.toHaveAttribute('aria-describedby')
  })

  it('moves focus into the dialog when it opens', () => {
    setup()
    expect(panel()).toHaveFocus()
  })

  it('leaves focus on a field inside that took it as the sheet opened', () => {
    render(
      <Sheet open onClose={vi.fn()} title="Rename">
        <input aria-label="Name" autoFocus />
      </Sheet>
    )
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus()
  })

  it('keeps Tab within the sheet, wrapping at either end', () => {
    render(
      <>
        <button type="button">Behind</button>
        <Sheet open onClose={vi.fn()} title="Pick">
          <button type="button">First</button>
          <button type="button">Last</button>
        </Sheet>
      </>
    )
    const first = screen.getByRole('button', { name: 'First' })
    const last = screen.getByRole('button', { name: 'Last' })
    // From the panel itself, Tab enters at the first control.
    expect(fireEvent.keyDown(panel(), { key: 'Tab' })).toBe(false)
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(first).toHaveFocus()
    // Other keys pass through.
    expect(fireEvent.keyDown(first, { key: 'a' })).toBe(true)
  })

  it('leaves Tab to a sheet opened over it', () => {
    render(
      <Sheet open onClose={vi.fn()} title="Outer">
        <button type="button">Outer button</button>
        <Sheet open onClose={vi.fn()} title="Inner">
          <button type="button">Inner one</button>
          <button type="button">Inner two</button>
        </Sheet>
      </Sheet>
    )
    const one = screen.getByRole('button', { name: 'Inner one' })
    const two = screen.getByRole('button', { name: 'Inner two' })
    one.focus()
    fireEvent.keyDown(one, { key: 'Tab' })
    expect(two).toHaveFocus()
  })

  it('gives focus back to what opened it once closed', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const view = setup()
    expect(panel()).toHaveFocus()
    view.rerender(
      <Sheet open={false} onClose={view.onClose} title="Options">
        <p>Sheet body</p>
      </Sheet>
    )
    expect(opener).toHaveFocus()
    opener.remove()
  })

  it('closes on a backdrop tap', () => {
    const { onClose } = setup()
    fireEvent.click(screen.getByTestId('sheet-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close on a tap inside the sheet', () => {
    const { onClose } = setup()
    fireEvent.click(screen.getByText('Sheet body'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    const { onClose } = setup()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores other keys, and Escape once closed', () => {
    const { onClose, rerender } = setup()
    fireEvent.keyDown(document, { key: 'Enter' })
    rerender(
      <Sheet open={false} onClose={onClose} title="Options">
        <p>Sheet body</p>
      </Sheet>
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes after a 100 px drag down on the handle', () => {
    const { onClose } = setup()
    drag([{ y: 100 }, { y: 150 }, { y: 200 }])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays open after a 40 px drag and settles back', () => {
    const { onClose } = setup()
    drag([{ y: 100 }, { y: 140 }])
    expect(onClose).not.toHaveBeenCalled()
    expect(panel().style.transform).toBe('')
  })

  it('follows the finger with a transform while dragging, never above its rest', () => {
    setup()
    const handle = screen.getByTestId('sheet-handle')
    fireEvent.pointerDown(handle, at({ y: 100 }))
    fireEvent.pointerMove(handle, at({ y: 130 }))
    expect(panel().style.transform).toBe('translate3d(0, 30px, 0)')
    fireEvent.pointerMove(handle, at({ y: 60 }))
    expect(panel().style.transform).toBe('translate3d(0, 0px, 0)')
  })

  it('ignores moves and releases from another pointer or without a press', () => {
    const { onClose } = setup()
    const handle = screen.getByTestId('sheet-handle')
    fireEvent.pointerMove(handle, at({ y: 300 }))
    fireEvent.pointerUp(handle, at({ y: 300 }))
    fireEvent.pointerDown(handle, at({ y: 100 }))
    fireEvent.pointerMove(handle, at({ y: 300, id: 2 }))
    fireEvent.pointerUp(handle, at({ y: 300, id: 2 }))
    expect(onClose).not.toHaveBeenCalled()
    expect(panel().style.transform).toBe('')
  })

  it('settles back without closing when the drag is cancelled', () => {
    const { onClose } = setup()
    const handle = screen.getByTestId('sheet-handle')
    fireEvent.pointerDown(handle, at({ y: 100 }))
    fireEvent.pointerMove(handle, at({ y: 250 }))
    fireEvent.pointerCancel(handle, at({ y: 250 }))
    fireEvent.pointerUp(handle, at({ y: 250 }))
    expect(onClose).not.toHaveBeenCalled()
    expect(panel().style.transform).toBe('')
  })
})
