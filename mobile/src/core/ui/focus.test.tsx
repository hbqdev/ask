import { fireEvent, render, screen } from '@testing-library/react'
import { useRef, type KeyboardEvent } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  focusHeading,
  isTextEntry,
  trapTab,
  useReturnFocus
} from '@/core/ui/focus'

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

describe('focusHeading', () => {
  function box(html: string): HTMLElement {
    const el = document.createElement('div')
    el.innerHTML = html
    document.body.append(el)
    return el
  }

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('focuses the h1 without scrolling, making it focusable', () => {
    const el = box('<p>intro</p><h1>Library</h1><h1>Second</h1>')
    const h1 = el.querySelector('h1')!
    const focus = vi.spyOn(h1, 'focus')
    expect(focusHeading(el)).toBe(true)
    expect(h1).toHaveFocus()
    expect(h1).toHaveAttribute('tabindex', '-1')
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('leaves a tabindex the heading already has', () => {
    const el = box('<h1 tabindex="0">Settings</h1>')
    expect(focusHeading(el)).toBe(true)
    expect(el.querySelector('h1')).toHaveAttribute('tabindex', '0')
    expect(el.querySelector('h1')).toHaveFocus()
  })

  it('skips a heading in a hidden part (an inactive tab or segment)', () => {
    const el = box(
      '<div inert><h1>Ask anything</h1></div>' +
        '<div style="visibility: hidden"><h1>Discover</h1></div>' +
        '<div hidden><h1>Notes</h1></div>' +
        '<h1>Library</h1>'
    )
    expect(focusHeading(el)).toBe(true)
    expect(screen.getByText('Library')).toHaveFocus()
  })

  it('returns false and moves nothing with no heading shown', () => {
    const el = box('<h2>Not a title</h2><div hidden><h1>Hidden</h1></div>')
    const before = document.activeElement
    expect(focusHeading(el)).toBe(false)
    expect(document.activeElement).toBe(before)
  })
})

describe('isTextEntry', () => {
  function el(html: string): Element {
    const box = document.createElement('div')
    box.innerHTML = html
    return box.querySelector('[data-t]')!
  }

  it.each([
    '<textarea data-t></textarea>',
    '<select data-t></select>',
    '<input data-t>',
    '<input data-t type="text">',
    '<input data-t type="search">',
    '<input data-t type="email">',
    '<input data-t type="password">',
    '<div data-t contenteditable></div>',
    '<div contenteditable="true"><p data-t>in an editor</p></div>'
  ])('%s raises the keyboard', html => {
    expect(isTextEntry(el(html))).toBe(true)
  })

  it.each([
    '<button data-t>Send</button>',
    '<input data-t type="checkbox">',
    '<input data-t type="radio">',
    '<input data-t type="button">',
    '<input data-t type="submit">',
    '<input data-t type="range">',
    '<div data-t role="button" tabindex="0">Row</div>',
    '<div contenteditable="false"><p data-t>read only</p></div>',
    '<a data-t href="#">link</a>'
  ])('%s does not', html => {
    expect(isTextEntry(el(html))).toBe(false)
  })
})
