import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatRowItem } from '@/features/library/ChatRowItem'
import type { ChatRow } from '@/features/library/library-api'

const NOW = new Date(2026, 9, 21, 15, 30)

const chat = (over: Partial<ChatRow> = {}): ChatRow => ({
  id: 'c1',
  title: 'Why is the sky blue?',
  createdAt: new Date(2026, 9, 18, 9, 0).toISOString(),
  lastViewedAt: null,
  fileCount: 0,
  ...over
})

function setup(row: ChatRow = chat(), time = row.createdAt, separator = false) {
  const onOpen = vi.fn()
  const onDelete = vi.fn()
  const onRename = vi.fn()
  render(
    <ul>
      <ChatRowItem
        chat={row}
        time={time}
        now={NOW}
        separator={separator}
        onOpen={onOpen}
        onDelete={onDelete}
        onRename={onRename}
      />
    </ul>
  )
  const item = screen.getByRole('listitem')
  // SwipeRow's pressable content (after its action buttons).
  const content = within(item).getAllByRole('button').at(-1)!
  return { onOpen, onDelete, onRename, item, content }
}

// Opens the row's actions with a left drag, as a finger would.
function swipeOpen(content: HTMLElement) {
  const at = (x: number) => ({
    clientX: x,
    clientY: 100,
    pointerId: 1,
    isPrimary: true
  })
  fireEvent.pointerDown(content, at(300))
  fireEvent.pointerMove(content, at(250))
  fireEvent.pointerMove(content, at(180))
  fireEvent.pointerUp(content, at(180))
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(375)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ChatRowItem', () => {
  it('draws an inset hairline under the row when it has a separator', () => {
    const { item, content } = setup(chat(), undefined, true)
    expect(item.className).not.toContain('border-b')
    const body = content.firstElementChild!
    expect(body).toHaveClass(
      'after:absolute',
      'after:bottom-0',
      'after:left-4',
      'after:right-0',
      'after:h-px',
      'after:bg-border'
    )
  })

  it('draws none without one (the last row of a group)', () => {
    const { item, content } = setup()
    expect(item.className).not.toContain('border-b')
    expect(content.firstElementChild!.className).not.toContain('after:')
  })

  it('shows the title and how long ago', () => {
    const { content } = setup()
    expect(content).toHaveTextContent('Why is the sky blue?')
    expect(content).toHaveTextContent('3 days ago')
  })

  it('reads the time from the date it is given', () => {
    const viewed = new Date(2026, 9, 20, 10, 0).toISOString()
    const { content } = setup(chat({ lastViewedAt: viewed }), viewed)
    expect(content).toHaveTextContent('yesterday')
    expect(content.querySelector('time')).toHaveAttribute('datetime', viewed)
  })

  it('falls back to "Untitled" for an empty title', () => {
    const { content } = setup(chat({ title: '' }))
    expect(content).toHaveTextContent('Untitled')
  })

  it.each([
    ['quality', 'Quality'],
    ['speed', 'Speed']
  ])('badges a %s chat', (searchMode, label) => {
    const { content } = setup(chat({ searchMode }))
    expect(within(content).getByText(label)).toBeInTheDocument()
  })

  it.each([['balanced'], [undefined]])(
    'shows no mode badge for %s (the default)',
    searchMode => {
      const { content } = setup(chat({ searchMode }))
      expect(within(content).queryByText(/Balanced|Quality|Speed/)).toBeNull()
    }
  )

  it('shows a paperclip with the file count when it has files', () => {
    const { content } = setup(chat({ fileCount: 2 }))
    expect(content).toHaveTextContent('2 files')
    expect(within(content).getByTestId('files-badge')).toBeInTheDocument()
  })

  it('says "file" for one file', () => {
    const { content } = setup(chat({ fileCount: 1 }))
    expect(content).toHaveTextContent('1 file')
    expect(content).not.toHaveTextContent('1 files')
  })

  it('shows no paperclip without files', () => {
    const { content } = setup()
    expect(within(content).queryByTestId('files-badge')).toBeNull()
  })

  it('lets the browser skip laying out rows off screen', () => {
    const { item } = setup()
    expect(item.style.getPropertyValue('content-visibility')).toBe('auto')
    expect(item.style.getPropertyValue('contain-intrinsic-size')).toMatch(
      /^auto \d+px$/
    )
  })

  it('opens the chat on a tap', () => {
    const row = chat()
    const { content, onOpen } = setup(row)
    fireEvent.click(content)
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(row)
  })

  it('offers Delete (destructive, first) and Rename on a swipe', () => {
    const row = chat()
    const { content, item, onDelete, onRename } = setup(row)
    swipeOpen(content)
    const [del, rename] = within(item)
      .getAllByRole('button')
      .filter(b => b !== content)
    expect(del).toHaveTextContent('Delete')
    expect(del.className).toContain('bg-red-600')
    expect(rename).toHaveTextContent('Rename')

    fireEvent.click(del)
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(row)

    swipeOpen(content)
    fireEvent.click(within(item).getByRole('button', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledExactlyOnceWith(row)
  })
})
