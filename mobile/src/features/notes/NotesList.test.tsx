import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StackProvider } from '@/core/nav/stack'
import type { Note } from '@/features/notes/notes-api'
import { NotesList } from '@/features/notes/NotesList'
import { openNote } from '@/features/notes/NoteScreen'
import { useNotes, type Notes } from '@/features/notes/useNotes'
import { intersect, isObserved, observerOf } from '@/test/intersection-observer'

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

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(375)
})

afterEach(() => {
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
      within(rowButton('Note 1').closest('li')!).getByRole('button', {
        name: 'Delete'
      })
    )
    const sheet = screen.getByRole('dialog', { name: 'Delete this note?' })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }))
    expect(value.remove).toHaveBeenCalledWith('n1')
  })

  it('cancelling the confirmation deletes nothing', () => {
    const value = notes()
    renderList(value)
    swipeOpen(rowButton('Note 1'))
    fireEvent.click(
      within(rowButton('Note 1').closest('li')!).getByRole('button', {
        name: 'Delete'
      })
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
