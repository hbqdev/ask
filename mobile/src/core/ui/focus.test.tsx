import { fireEvent, render, screen } from '@testing-library/react'
import { useRef, type KeyboardEvent } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { trapTab, useReturnFocus } from '@/core/ui/focus'

function Modal() {
  useReturnFocus()
  return <p>modal</p>
}

function Host({ open }: { open: boolean }) {
  return (
    <>
      <button type="button">opener</button>
      {open && <Modal />}
    </>
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useReturnFocus', () => {
  it('gives focus back to what had it before the modal opened', () => {
    const view = render(<Host open={false} />)
    const opener = screen.getByRole('button', { name: 'opener' })
    opener.focus()
    view.rerender(<Host open />)
    // Something inside the modal takes focus meanwhile.
    ;(document.activeElement as HTMLElement).blur()
    expect(opener).not.toHaveFocus()

    view.rerender(<Host open={false} />)
    expect(opener).toHaveFocus()
  })

  it('returns focus without scrolling the page', () => {
    const view = render(<Host open={false} />)
    const opener = screen.getByRole('button', { name: 'opener' })
    opener.focus()
    view.rerender(<Host open />)
    const focus = vi.spyOn(opener, 'focus')
    view.rerender(<Host open={false} />)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('does nothing when nothing had focus', () => {
    vi.spyOn(Document.prototype, 'activeElement', 'get').mockReturnValue(null)
    const view = render(<Host open />)
    expect(() => view.rerender(<Host open={false} />)).not.toThrow()
  })
})

function Trap({ buttons }: { buttons: string[] }) {
  const box = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={box}
      data-testid="box"
      tabIndex={-1}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) =>
        trapTab(e.nativeEvent, box.current!)
      }
    >
      {buttons.map(name => (
        <button key={name} type="button">
          {name}
        </button>
      ))}
      <button type="button" disabled>
        off
      </button>
      <a>no href</a>
    </div>
  )
}

describe('trapTab', () => {
  const tab = (shiftKey = false) =>
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey })

  it('moves forward and wraps from the last to the first', () => {
    render(<Trap buttons={['a', 'b', 'c']} />)
    screen.getByRole('button', { name: 'b' }).focus()
    tab()
    expect(screen.getByRole('button', { name: 'c' })).toHaveFocus()
    tab()
    expect(screen.getByRole('button', { name: 'a' })).toHaveFocus()
  })

  it('moves back and wraps from the first to the last', () => {
    render(<Trap buttons={['a', 'b', 'c']} />)
    screen.getByRole('button', { name: 'a' }).focus()
    tab(true)
    expect(screen.getByRole('button', { name: 'c' })).toHaveFocus()
    tab(true)
    expect(screen.getByRole('button', { name: 'b' })).toHaveFocus()
  })

  it('enters at the first, or with Shift the last, from the container', () => {
    render(<Trap buttons={['a', 'b']} />)
    screen.getByTestId('box').focus()
    tab()
    expect(screen.getByRole('button', { name: 'a' })).toHaveFocus()
    screen.getByTestId('box').focus()
    tab(true)
    expect(screen.getByRole('button', { name: 'b' })).toHaveFocus()
  })

  it('keeps focus on the container when nothing inside can take it', () => {
    render(<Trap buttons={[]} />)
    const box = screen.getByTestId('box')
    box.focus()
    tab()
    expect(box).toHaveFocus()
  })

  it('leaves other keys alone', () => {
    render(<Trap buttons={['a', 'b']} />)
    screen.getByRole('button', { name: 'a' }).focus()
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true
    })
    document.activeElement!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(screen.getByRole('button', { name: 'a' })).toHaveFocus()
  })

  it('stops the browser moving focus itself', () => {
    render(<Trap buttons={['a']} />)
    screen.getByRole('button', { name: 'a' }).focus()
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true
    })
    document.activeElement!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})
