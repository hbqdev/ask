// The signed-in user's notes, kept in memory only (never on disk), so the
// Notes list, a note's screen and an answer's Save to notes agree: a note
// saved or deleted on one screen shows on the others at once. It also
// remembers which answers were saved this session, so an answer is not saved
// twice. Everything is tagged with the user it belongs to and ignored for
// anyone else; sign-out and an account change reset it (AuthProvider).

import type { Note, NotesCursor } from '@/features/notes/notes-api'

/** The loaded notes of one user, and where the next page starts. */
export type NotesCache = {
  userId: string
  notes: Note[]
  nextCursor: NotesCursor | null
}

/** A note taken out of the list, and where it was. */
export type DroppedNote = { note: Note; index: number }

let cache: NotesCache | null = null
// The answers saved this session, by message id, and whose they are.
let saved: { userId: string; messageIds: Set<string> } | null = null
const listeners = new Set<() => void>()

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

/** Replaces the list (a first page from the server). */
export function setNotesCache(next: NotesCache): void {
  cache = next
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
    if (saved?.userId !== userId) saved = { userId, messageIds: new Set() }
    saved.messageIds.add(note.sourceMessageId)
  }
  const mine = cacheOf(userId)
  if (!mine) return
  setNotesCache({
    ...mine,
    notes: [note, ...mine.notes.filter(n => n.id !== note.id)]
  })
}

/**
 * Takes a note out of `userId`'s list; its answer can be saved again. Null
 * when it is not listed.
 */
export function dropNote(userId: string, id: string): DroppedNote | null {
  const mine = cacheOf(userId)
  const index = mine ? mine.notes.findIndex(n => n.id === id) : -1
  if (!mine || index < 0) return null
  const note = mine.notes[index]
  if (note.sourceMessageId && saved?.userId === userId) {
    saved.messageIds.delete(note.sourceMessageId)
  }
  setNotesCache({ ...mine, notes: mine.notes.filter(n => n.id !== id) })
  return { note, index }
}

/** Puts a dropped note back where it was (a delete that failed). */
export function restoreNote(userId: string, { note, index }: DroppedNote) {
  const mine = cacheOf(userId)
  if (!mine || mine.notes.some(n => n.id === note.id)) return
  const notes = [...mine.notes]
  notes.splice(Math.min(index, notes.length), 0, note)
  setNotesCache({ ...mine, notes })
}

/** A listed note of `userId`'s. */
export function findNote(userId: string, id: string): Note | undefined {
  return cacheOf(userId)?.notes.find(n => n.id === id)
}

/** Whether `userId` has saved this answer: this session, or a listed note. */
export function isMessageSaved(userId: string, messageId: string): boolean {
  if (saved?.userId === userId && saved.messageIds.has(messageId)) return true
  return (
    cacheOf(userId)?.notes.some(n => n.sourceMessageId === messageId) ?? false
  )
}

/** Forgets everything (sign-out, another account). */
export function resetNotesCache(): void {
  cache = null
  saved = null
  notify()
}
