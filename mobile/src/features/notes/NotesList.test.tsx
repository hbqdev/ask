import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StackProvider } from '@/core/nav/stack'
import type { Note } from '@/features/notes/notes-api'
import { NotesList } from '@/features/notes/NotesList'
import { openNote } from '@/features/notes/NoteScreen'
import { useNotes, type Notes } from '@/features/notes/useNotes'
import { intersect, isObserved, observerOf } from '@/test/intersection-observer'
import { expectReadableInScroller, readableColumn } from '@/test/readable'
import { installVirtualLayout } from '@/test/virtual-layout'

vi.mock('@/features/notes/useNotes', () => ({ useNotes: vi.fn() }))
vi.mock('@/features/notes/NoteScreen', () => ({ openNote: vi.fn() }))
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: async () => {} })) }
}))

const NOW = new Date(2026, 9, 21, 15, 30)
const daysAgo = (n: number) => new Date(2026, 9, 21 - n, 12).toISOString()

const note = (n: number, over: Partial<Note> = {}): Note => ({
  id: `n${n}`,
  title: `Note ${n}`,
  content: `**Content** ${n}`,
  chatId: null,
  sourceMessageId: null,
  createdAt: daysAgo(n),
  updatedAt: daysAgo(n),
  ...over
})

const NOTES = [note(0), note(1), note(40)]

function notes(over: Partial<Notes> = {}): Notes {
  return {
    notes: NOTES,
    status: 'ready',
    error: undefined,
    hasMore: false,
    loadMore: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    remove: vi.fn(async () => true),
    ...over
  }
}

function renderList(value: Notes = notes()) {
  vi.mocked(useNotes).mockReturnValue(value)
  const root = { key: 'root', render: () => <NotesList /> }
  const utils = render(
    <StackProvider root={root}>
      <NotesList />
    </StackProvider>
  )
  return {
    ...utils,
    update(next: Notes) {
      vi.mocked(useNotes).mockReturnValue(next)
      utils.rerender(
        <StackProvider root={root}>
          <NotesList />
        </StackProvider>
      )
    }
  }
}

const rowButton = (title: string) =>
  screen.getByRole('button', { name: new RegExp(`^${title}`) })

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

// Tall enough that every row of a short list mounts.
let restoreLayout = () => {}

beforeEach(() => {
  restoreLayout = installVirtualLayout({ viewport: 100_000, item: 72 })
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(375)
})

afterEach(() => {
  restoreLayout()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('NotesList', () => {
  it('lists the notes under date headings, with a plain-text preview', () => {
    renderList()
    const headings = screen.getAllByRole('heading', { level: 2 })
    expect(headings.map(h => h.textContent)).toEqual([
      'Today',
      'Yesterday',
      'September 2026'
    ])
    const row = rowButton('Note 0')
    expect(row).toHaveTextContent('Content 0')
    expect(row).not.toHaveTextContent('**')
  })

  it('on an iPad, sets the rows in the readable column, the pull area full width', () => {
    renderList()
    expectReadableInScroller(rowButton('Note 0'))
    expect(readableColumn(screen.getByTestId('notes-content'))).toBeNull()
  })

  it('separates every row but the last of its date group with an inset hairline', () => {
    renderList(
      notes({
        notes: [note(0), note(0, { id: 'n9', title: 'Note 9' }), note(40)]
      })
    )
    const separated = (title: string) =>
      rowButton(title).firstElementChild!.className.includes('after:h-px')
    // Today: two rows; September: one.
    expect(separated('Note 0')).toBe(true)
    expect(separated('Note 9')).toBe(false)
    expect(separated('Note 40')).toBe(false)
    for (const item of document.querySelectorAll('.swipe-row')) {
      expect(item.className).not.toContain('border-b')
    }
    // Rows of a windowed list: no list role.
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('opens a note on a tap', () => {
    renderList()
    fireEvent.click(rowButton('Note 1'))
    expect(openNote).toHaveBeenCalledWith(expect.any(Function), NOTES[1])
  })

  it('names an untitled note', () => {
    renderList(notes({ notes: [note(0, { title: '' })] }))
    expect(rowButton('Untitled')).toBeInTheDocument()
  })

  it('deletes after a confirmation from the swipe', () => {
    const value = notes()
    renderList(value)
    swipeOpen(rowButton('Note 1'))
    fireEvent.click(
      within(rowButton('Note 1').closest<HTMLElement>('.swipe-row')!).getByRole(
        'button',
        {
          name: 'Delete'
        }
      )
    )
    const sheet = screen.getByRole('dialog', { name: 'Delete this note?' })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }))
    expect(value.remove).toHaveBeenCalledWith('n1')
  })

  it('deletes after a confirmation from a long press, its sheet titled with the note', () => {
    const value = notes()
    renderList(value)
    expect(rowButton('Note 1')).toHaveAccessibleDescription(
      'Touch and hold for Delete.'
    )
    expect(rowButton('Note 1').querySelector('.selectable')).toBeNull()
    fireEvent.contextMenu(rowButton('Note 1'))
    const actions = screen.getByRole('dialog', { name: 'Note 1' })
    fireEvent.click(within(actions).getByRole('button', { name: 'Delete' }))
    const sheet = screen.getByRole('dialog', { name: 'Delete this note?' })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }))
    expect(value.remove).toHaveBeenCalledWith('n1')
  })

  it('titles an untitled note’s actions Untitled', () => {
    renderList(notes({ notes: [note(0, { title: '' })] }))
    fireEvent.contextMenu(rowButton('Untitled'))
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Untitled')
  })

  it('cancelling the confirmation deletes nothing', () => {
    const value = notes()
    renderList(value)
    swipeOpen(rowButton('Note 1'))
    fireEvent.click(
      within(rowButton('Note 1').closest<HTMLElement>('.swipe-row')!).getByRole(
        'button',
        {
          name: 'Delete'
        }
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(value.remove).not.toHaveBeenCalled()
  })

  it('shows a skeleton while the first page loads', () => {
    renderList(notes({ notes: [], status: 'loading' }))
    expect(
      screen.getByRole('status', { name: 'Loading notes' })
    ).toBeInTheDocument()
  })

  it('shows a skeleton while an empty list refreshes', () => {
    renderList(notes({ notes: [], status: 'refreshing' }))
    expect(
      screen.getByRole('status', { name: 'Loading notes' })
    ).toBeInTheDocument()
  })

  it('says how to save a note when there are none', () => {
    renderList(notes({ notes: [] }))
    expect(screen.getByText('No notes yet')).toBeInTheDocument()
    expect(screen.getByText(/Save to notes/)).toBeInTheDocument()
  })

  it('shows a failed first load with Retry', () => {
    const value = notes({ notes: [], status: 'error', error: 'Boom' })
    renderList(value)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t load your notes')
    expect(alert).toHaveTextContent('Boom')
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(value.refresh).toHaveBeenCalled()
  })

  it('says notes aren’t available on a server without accounts, offering no retry', () => {
    renderList(
      notes({
        notes: [],
        status: 'unavailable',
        error: 'Notes aren’t available on this server.'
      })
    )
    expect(
      screen.getByText('Notes aren’t available on this server')
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Retry' })
    ).not.toBeInTheDocument()
  })

  it('keeps the rows and offers Retry when a later load fails', () => {
    const value = notes({ status: 'error', error: 'Down' })
    renderList(value)
    expect(rowButton('Note 0')).toBeInTheDocument()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Down')
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(value.refresh).toHaveBeenCalled()
  })

  it('loads the next page as its end comes into view', () => {
    const value = notes({ hasMore: true })
    renderList(value)
    const sentinel = screen.getByTestId('notes-more')
    expect(isObserved(sentinel)).toBe(true)
    expect(observerOf(sentinel)!.rootMargin).toBe('0px 0px 600px 0px')
    act(() => intersect(sentinel))
    expect(value.loadMore).toHaveBeenCalled()
  })

  it('loads the rest when every loaded note was deleted but more remain', () => {
    renderList(notes({ notes: [], hasMore: true }))
    expect(screen.getByTestId('notes-more')).toBeInTheDocument()
    expect(
      screen.getByRole('status', { name: 'Loading notes' })
    ).toBeInTheDocument()
  })

  it('refreshes on a pull down from the top', async () => {
    const value = notes()
    renderList(value)
    const scroller = screen.getByTestId('notes-scroll')
    const touch = (y: number) => ({ identifier: 0, clientX: 100, clientY: y })
    fireEvent.touchStart(scroller, {
      touches: [touch(100)],
      changedTouches: [touch(100)]
    })
    fireEvent.touchMove(scroller, {
      touches: [touch(400)],
      changedTouches: [touch(400)]
    })
    await act(async () =>
      fireEvent.touchEnd(scroller, {
        touches: [],
        changedTouches: [touch(400)]
      })
    )
    expect(value.refresh).toHaveBeenCalledOnce()
  })

  it('does not render again for an unchanged list', () => {
    const value = notes()
    const { update } = renderList(value)
    const row = rowButton('Note 0')
    update({ ...value })
    expect(rowButton('Note 0')).toBe(row)
  })
})

describe('NotesList windowing', () => {
  // A phone's worth of list: 300 px, headers 38 px and rows 88 px high (as
  // measured at the default text size, so the estimates hold).
  beforeEach(() => {
    restoreLayout()
    restoreLayout = installVirtualLayout({
      viewport: 300,
      item: el => (el.querySelector('h2') ? 38 : 88)
    })
  })

  /** `n` notes, all saved 10 days ago: one section of n rows. */
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      note(10, { id: `m${i}`, title: `Many ${i}` })
    )

  // The section's header comes first: row i is item i + 1.
  const rowTop = (i: number) => 38 + i * 88
  const rowCount = () => document.querySelectorAll('.swipe-row').length

  function scrollList(top: number) {
    const scroller = screen.getByTestId('notes-scroll')
    act(() => {
      scroller.scrollTop = top
      fireEvent.scroll(scroller)
    })
  }

  it('mounts only the rows on screen, however long the list', () => {
    renderList(notes({ notes: many(500) }))
    expect(rowButton('Many 0')).toBeInTheDocument()
    expect(rowCount()).toBeLessThan(60)

    scrollList(rowTop(499))
    expect(rowButton('Many 499')).toBeInTheDocument()
    expect(screen.queryByText('Many 0')).toBeNull()
    expect(rowCount()).toBeLessThan(60)
  })

  it('keeps the section’s header at the top, opaque', () => {
    renderList(notes({ notes: many(200) }))
    scrollList(rowTop(100))
    const heading = screen.getByRole('heading', { level: 2 })
    const item = heading.closest<HTMLElement>('[data-index]')!
    expect(item.style.position).toBe('sticky')
    expect(item).toHaveClass('bg-background')
    for (const el of [heading, item]) {
      expect(el.className).not.toMatch(/backdrop-blur|bg-background\//)
    }
  })

  it('loads the next page when the end comes into view', () => {
    const value = notes({ notes: many(100), hasMore: true })
    // The hook's state, as a page landing changes it.
    let land: (next: Notes) => void = () => {}
    vi.mocked(useNotes).mockImplementation(() => {
      const [state, set] = useState(value)
      land = set
      return state
    })
    render(
      <StackProvider root={{ key: 'root', render: () => <NotesList /> }}>
        <NotesList />
      </StackProvider>
    )
    // The end follows the whole list's box, not the rows mounted.
    const sentinel = screen.getByTestId('notes-more')
    expect((sentinel.previousElementSibling as HTMLElement).style.height).toBe(
      `${rowTop(100)}px`
    )
    act(() => intersect(sentinel))
    expect(value.loadMore).toHaveBeenCalledOnce()

    act(() => land({ ...value, notes: many(200), hasMore: false }))
    scrollList(rowTop(199))
    expect(rowButton('Many 199')).toBeInTheDocument()
    expect(rowCount()).toBeLessThan(60)
  })

  it('a swiped-open row scrolled out of the window releases its open state', () => {
    renderList(notes({ notes: many(300) }))
    swipeOpen(rowButton('Many 0'))
    scrollList(rowTop(200))
    expect(screen.queryByText('Many 0')).toBeNull()

    const target = rowButton('Many 200')
    fireEvent.pointerDown(target, {
      clientX: 200,
      clientY: 100,
      isPrimary: true
    })
    fireEvent.pointerUp(target, { clientX: 200, clientY: 100, isPrimary: true })
    fireEvent.click(target)
    expect(openNote).toHaveBeenCalledOnce()
  })

  it('deletes a row far down the list', () => {
    const value = notes({ notes: many(300) })
    renderList(value)
    scrollList(rowTop(150))
    swipeOpen(rowButton('Many 150'))
    fireEvent.click(
      within(
        rowButton('Many 150').closest<HTMLElement>('.swipe-row')!
      ).getByRole('button', { name: 'Delete' })
    )
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: 'Delete this note?' })
      ).getByRole('button', { name: 'Delete' })
    )
    expect(value.remove).toHaveBeenCalledWith('m150')
  })
})
