import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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
