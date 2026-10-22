// Notes' calls to Ask's notes routes (app/api/notes/**): the keyset-paged
// list, save, one note, and delete. A server in anonymous mode keeps no notes
// and answers every call with 403.

import type { ApiClient } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'

/** A saved note. Dates are ISO strings. */
export type Note = {
  id: string
  title: string
  content: string
  /** The chat it was saved from, while that chat exists. */
  chatId: string | null
  /** The answer (assistant message) it was saved from. */
  sourceMessageId: string | null
  createdAt: string
  updatedAt: string
}

/** Where the next page starts: after this note, newest update first. */
export type NotesCursor = { updatedAt: string; id: string }

export type NotesPage = {
  notes: Note[]
  /** The next page's cursor, or null when this was the last page. */
  nextCursor: NotesCursor | null
}

export type NewNote = {
  content: string
  /** The server derives one from the content when none is given. */
  title?: string
  chatId?: string
  sourceMessageId?: string
}

/** Notes per page (the server allows 1 to 50). */
export const NOTES_PAGE_SIZE = 25

export const NOTES_UNAVAILABLE = 'Notes aren’t available on this server.'

type ServerNote = Omit<Note, 'chatId' | 'sourceMessageId'> & {
  chatId?: string | null
  sourceMessageId?: string | null
}

type ListResponse = {
  notes: ServerNote[]
  nextCursor: NotesCursor | null
  hasMore: boolean
}

const notePath = (id: string) => `/api/notes/${encodeURIComponent(id)}`

const toNote = (note: ServerNote): Note => ({
  id: note.id,
  title: note.title,
  content: note.content,
  chatId: note.chatId ?? null,
  sourceMessageId: note.sourceMessageId ?? null,
  createdAt: note.createdAt,
  updatedAt: note.updatedAt
})

/** One page of the user's notes, newest update first. */
export async function fetchNotesPage(
  client: ApiClient,
  {
    cursor,
    limit = NOTES_PAGE_SIZE
  }: { cursor?: NotesCursor; limit?: number } = {}
): Promise<NotesPage> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) {
    params.set('cursorUpdatedAt', cursor.updatedAt)
    params.set('cursorId', cursor.id)
  }
  const body = await client.json<ListResponse>(`/api/notes?${params}`)
  return {
    notes: body.notes.map(toNote),
    nextCursor: body.hasMore ? body.nextCursor : null
  }
}

/** Saves a note; resolves with it as the server saved it. */
export async function saveNote(
  client: ApiClient,
  note: NewNote
): Promise<Note> {
  const body = await client.json<{ note: ServerNote }>('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(note)
  })
  return toNote(body.note)
}

/** One note; rejects with a 404 ApiError when it is gone. */
export async function fetchNote(client: ApiClient, id: string): Promise<Note> {
  const body = await client.json<{ note: ServerNote }>(notePath(id))
  return toNote(body.note)
}

export async function deleteNote(client: ApiClient, id: string): Promise<void> {
  await client.json(notePath(id), { method: 'DELETE' })
}

/** Whether a failure means the server keeps no notes (anonymous mode). */
export function isNotesUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403
}
