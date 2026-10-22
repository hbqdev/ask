import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Note } from '@/features/notes/notes-api'
import {
  addNote,
  appendNotes,
  dropNote,
  findNote,
  getNotesCache,
  isMessageSaved,
  resetNotesCache,
  restoreNote,
  setNotesCache,
  subscribeNotesCache
} from '@/features/notes/notes-cache'

const note = (n: number, over: Partial<Note> = {}): Note => ({
  id: `n${n}`,
  title: `Note ${n}`,
  content: `Content ${n}`,
  chatId: null,
  sourceMessageId: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-21T08:00:00.000Z',
  ...over
})

const CURSOR = { updatedAt: '2026-10-21T08:00:00.000Z', id: 'n2' }

beforeEach(() => {
  resetNotesCache()
})

describe('the notes cache', () => {
  it('starts empty', () => {
    expect(getNotesCache()).toBeNull()
  })

  it('holds a user’s list and tells subscribers', () => {
    const fn = vi.fn()
    const unsubscribe = subscribeNotesCache(fn)
    setNotesCache({ userId: 'u1', notes: [note(1)], nextCursor: CURSOR })
    expect(getNotesCache()).toEqual({
      userId: 'u1',
      notes: [note(1)],
      nextCursor: CURSOR
    })
    expect(fn).toHaveBeenCalledTimes(1)
    unsubscribe()
    setNotesCache({ userId: 'u1', notes: [], nextCursor: null })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('keeps one object between changes', () => {
    setNotesCache({ userId: 'u1', notes: [note(1)], nextCursor: null })
    expect(getNotesCache()).toBe(getNotesCache())
  })

  it('reset forgets the list and the saved answers, and tells subscribers', () => {
    setNotesCache({ userId: 'u1', notes: [note(1)], nextCursor: null })
    addNote('u1', note(2, { sourceMessageId: 'm2' }))
    const fn = vi.fn()
    subscribeNotesCache(fn)
    resetNotesCache()
    expect(getNotesCache()).toBeNull()
    expect(isMessageSaved('u1', 'm2')).toBe(false)
    expect(fn).toHaveBeenCalled()
  })
})

describe('appendNotes', () => {
  it('adds a page after the list, without repeats, with its cursor', () => {
    setNotesCache({
      userId: 'u1',
      notes: [note(1), note(2)],
      nextCursor: CURSOR
    })
    appendNotes('u1', [note(2), note(3)], null)
    expect(getNotesCache()).toEqual({
      userId: 'u1',
      notes: [note(1), note(2), note(3)],
      nextCursor: null
    })
  })

  it('changes nothing for another user, or with no list', () => {
    appendNotes('u1', [note(1)], null)
    expect(getNotesCache()).toBeNull()
    setNotesCache({ userId: 'u1', notes: [note(1)], nextCursor: CURSOR })
    appendNotes('u2', [note(9)], null)
    expect(getNotesCache()!.notes).toEqual([note(1)])
  })
})

describe('addNote', () => {
  it('puts a saved note first in the user’s list', () => {
    setNotesCache({ userId: 'u1', notes: [note(1)], nextCursor: CURSOR })
    addNote('u1', note(2))
    expect(getNotesCache()!.notes.map(n => n.id)).toEqual(['n2', 'n1'])
    expect(getNotesCache()!.nextCursor).toBe(CURSOR)
  })

  it('moves a note already listed to the top instead of repeating it', () => {
    setNotesCache({ userId: 'u1', notes: [note(1), note(2)], nextCursor: null })
    addNote('u1', note(2, { title: 'New' }))
    expect(getNotesCache()!.notes.map(n => n.title)).toEqual(['New', 'Note 1'])
  })

  it('leaves another user’s list alone, and makes none when there is none', () => {
    addNote('u1', note(1))
    expect(getNotesCache()).toBeNull()
    setNotesCache({ userId: 'u2', notes: [note(5)], nextCursor: null })
    addNote('u1', note(1))
    expect(getNotesCache()!.notes).toEqual([note(5)])
  })

  it('remembers the answer it came from, for that user only', () => {
    addNote('u1', note(1, { sourceMessageId: 'm1' }))
    expect(isMessageSaved('u1', 'm1')).toBe(true)
    expect(isMessageSaved('u2', 'm1')).toBe(false)
    expect(isMessageSaved('u1', 'm2')).toBe(false)
    // Another user's save starts their own record.
    addNote('u2', note(2, { sourceMessageId: 'm2' }))
    expect(isMessageSaved('u2', 'm2')).toBe(true)
    expect(isMessageSaved('u1', 'm1')).toBe(false)
  })

  it('remembers nothing for a note from no answer', () => {
    addNote('u1', note(1))
    expect(isMessageSaved('u1', '')).toBe(false)
  })
})

describe('isMessageSaved', () => {
  it('is also true for an answer whose note is in the loaded list', () => {
    setNotesCache({
      userId: 'u1',
      notes: [note(1, { sourceMessageId: 'm1' })],
      nextCursor: null
    })
    expect(isMessageSaved('u1', 'm1')).toBe(true)
    expect(isMessageSaved('u2', 'm1')).toBe(false)
  })
})

describe('dropNote and restoreNote', () => {
  it('takes a note out, saying where it was, and puts it back there', () => {
    // Saved here this session (before any list was loaded), then listed.
    addNote('u1', note(2, { sourceMessageId: 'm2' }))
    setNotesCache({
      userId: 'u1',
      notes: [note(1), note(2, { sourceMessageId: 'm2' }), note(3)],
      nextCursor: null
    })
    const dropped = dropNote('u1', 'n2')
    expect(dropped).toEqual({
      note: note(2, { sourceMessageId: 'm2' }),
      index: 1
    })
    expect(getNotesCache()!.notes.map(n => n.id)).toEqual(['n1', 'n3'])
    // Its answer can be saved again.
    expect(isMessageSaved('u1', 'm2')).toBe(false)
    restoreNote('u1', dropped!)
    expect(getNotesCache()!.notes.map(n => n.id)).toEqual(['n1', 'n2', 'n3'])
    expect(isMessageSaved('u1', 'm2')).toBe(true)
  })

  it('drops nothing that is not listed for that user', () => {
    expect(dropNote('u1', 'n1')).toBeNull()
    setNotesCache({ userId: 'u1', notes: [note(1)], nextCursor: null })
    expect(dropNote('u1', 'n9')).toBeNull()
    expect(dropNote('u2', 'n1')).toBeNull()
    expect(getNotesCache()!.notes).toEqual([note(1)])
  })

  it('restores at the end when the list got shorter, and never twice', () => {
    setNotesCache({ userId: 'u1', notes: [note(1), note(2)], nextCursor: null })
    const dropped = dropNote('u1', 'n2')!
    setNotesCache({ userId: 'u1', notes: [], nextCursor: null })
    restoreNote('u1', dropped)
    restoreNote('u1', dropped)
    expect(getNotesCache()!.notes.map(n => n.id)).toEqual(['n2'])
  })

  it('restores into no other user’s list', () => {
    setNotesCache({ userId: 'u1', notes: [note(1)], nextCursor: null })
    const dropped = dropNote('u1', 'n1')!
    setNotesCache({ userId: 'u2', notes: [], nextCursor: null })
    restoreNote('u1', dropped)
    expect(getNotesCache()!.notes).toEqual([])
    resetNotesCache()
    restoreNote('u1', dropped)
    expect(getNotesCache()).toBeNull()
  })
})

describe('findNote', () => {
  it('finds a listed note of that user', () => {
    setNotesCache({ userId: 'u1', notes: [note(1)], nextCursor: null })
    expect(findNote('u1', 'n1')).toEqual(note(1))
    expect(findNote('u1', 'n2')).toBeUndefined()
    expect(findNote('u2', 'n1')).toBeUndefined()
  })

  it('finds nothing with no list', () => {
    expect(findNote('u1', 'n1')).toBeUndefined()
  })
})
