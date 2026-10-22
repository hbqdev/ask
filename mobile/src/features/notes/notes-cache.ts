// The signed-in user's notes, kept in memory only (never on disk), so the
// Notes list, a note's screen and an answer's Save to notes agree: a note
// saved or deleted on one screen shows on the others at once. It also
// remembers which answers were saved this session, so an answer is not saved
// twice, and which notes are being or were deleted here, so a page read
// before a delete landed never shows the note again. Everything is tagged
// with the user it belongs to and ignored for anyone else; sign-out and an
// account change reset it (AuthProvider). A load or save that settles after a
// reset must not write: writers compare getNotesEpoch() before and after.

import type { Note, NotesCursor } from '@/features/notes/notes-api'

/** The loaded notes of one user, and where the next page starts. */
export type NotesCache = {
  userId: string
  notes: Note[]
  nextCursor: NotesCursor | null
}

/** A note taken out of the list, and where it was. */
export type DroppedNote = { note: Note; index: number }

/** Ids of one user's, as a set. */
type UserIds = { userId: string; ids: Set<string> }

let cache: NotesCache | null = null
// The answers saved this session, by message id, and whose they are.
let saved: UserIds | null = null
// The notes deleted here (on their way or done), kept out of any list.
let removed: UserIds | null = null
// Bumped by every reset.
let epoch = 0
const listeners = new Set<() => void>()

/** `set`, made `userId`'s (a new one when it was another user's). */
const idsOf = (set: UserIds | null, userId: string): UserIds =>
  set?.userId === userId ? set : { userId, ids: new Set() }

/** `notes` without the ones `userId` deleted here. */
const withoutRemoved = (userId: string, notes: Note[]) =>
  removed?.userId === userId
    ? notes.filter(n => !removed!.ids.has(n.id))
    : notes

function notify() {
  for (const listener of [...listeners]) listener()
}

/** The cache for `userId`, if that is whose it is. */
const cacheOf = (userId: string) => (cache?.userId === userId ? cache : null)

/** Subscribes `fn` to changes; returns the unsubscribe. */
export function subscribeNotesCache(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** The cached list (one object between changes), whoever it belongs to. */
export function getNotesCache(): NotesCache | null {
  return cache
}

/** Changes only with a reset: a write started before it must not land. */
export function getNotesEpoch(): number {
  return epoch
}

/** Replaces the list (a first page from the server), less deleted notes. */
export function setNotesCache(next: NotesCache): void {
  cache = { ...next, notes: withoutRemoved(next.userId, next.notes) }
  notify()
}

/** Adds a next page after `userId`'s list, leaving out notes it has. */
export function appendNotes(
  userId: string,
  notes: Note[],
  nextCursor: NotesCursor | null
): void {
  const mine = cacheOf(userId)
  if (!mine) return
  const have = new Set(mine.notes.map(n => n.id))
  setNotesCache({
    userId,
    notes: [...mine.notes, ...notes.filter(n => !have.has(n.id))],
    nextCursor
  })
}

/**
 * A note just saved: first in `userId`'s list (if one is loaded), and its
 * answer remembered as saved.
 */
export function addNote(userId: string, note: Note): void {
  if (note.sourceMessageId) {
    saved = idsOf(saved, userId)
    saved.ids.add(note.sourceMessageId)
  }
  const mine = cacheOf(userId)
  if (!mine) return
  setNotesCache({
    ...mine,
    notes: [note, ...mine.notes.filter(n => n.id !== note.id)]
  })
}

/**
 * A delete of `userId`'s note `id`, on its way or done: the note is kept out
 * of every list from now on, and taken out of the loaded one (its answer can
 * be saved again). Returns it and where it was, or null when not listed.
 */
export function dropNote(userId: string, id: string): DroppedNote | null {
  removed = idsOf(removed, userId)
  removed.ids.add(id)
  const mine = cacheOf(userId)
  const index = mine ? mine.notes.findIndex(n => n.id === id) : -1
  if (!mine || index < 0) return null
  const note = mine.notes[index]
  if (note.sourceMessageId && saved?.userId === userId) {
    saved.ids.delete(note.sourceMessageId)
  }
  setNotesCache({ ...mine, notes: mine.notes.filter(n => n.id !== id) })
  return { note, index }
}

/**
 * A delete that failed: the note may show again, and `dropped` (what
 * dropNote returned) goes back where it was.
 */
export function restoreNote(
  userId: string,
  id: string,
  dropped: DroppedNote | null
): void {
  if (removed?.userId === userId) removed.ids.delete(id)
  const mine = cacheOf(userId)
  if (!dropped || !mine || mine.notes.some(n => n.id === id)) return
  const notes = [...mine.notes]
  notes.splice(Math.min(dropped.index, notes.length), 0, dropped.note)
  setNotesCache({ ...mine, notes })
}

/** A listed note of `userId`'s. */
export function findNote(userId: string, id: string): Note | undefined {
  return cacheOf(userId)?.notes.find(n => n.id === id)
}

/** Whether `userId` has saved this answer: this session, or a listed note. */
export function isMessageSaved(userId: string, messageId: string): boolean {
  if (saved?.userId === userId && saved.ids.has(messageId)) return true
  return (
    cacheOf(userId)?.notes.some(n => n.sourceMessageId === messageId) ?? false
  )
}

/** Forgets everything (sign-out, another account). */
export function resetNotesCache(): void {
  cache = null
  saved = null
  removed = null
  epoch++
  notify()
}
