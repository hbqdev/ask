import { NextResponse } from 'next/server'

import type { Note } from '@/lib/db/schema'

// Shared by the /api/notes routes: native-client wrappers around the
// self-resolving actions in lib/actions/notes.ts, which report failures as
// error strings. Those strings are mapped to statuses here.

// The note as the API exposes it (the owner's userId is left out).
export function toNoteJson(note: Note) {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    chatId: note.chatId,
    sourceMessageId: note.sourceMessageId,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  }
}

// requireNoteUserId's two refusals: notes are off in anonymous mode
// (ENABLE_AUTH=false) → 403 with the action's message, no user → 401.
const ANONYMOUS_MODE = 'Library is unavailable in anonymous mode.'
const SIGNED_OUT = 'Sign in to save notes.'
const NOT_FOUND = 'Note not found'

// Any other error is a failed read or write, reported as a retryable 500.
export function noteErrorResponse(error: string | undefined, fallback: string) {
  if (error === ANONYMOUS_MODE) {
    return NextResponse.json({ error }, { status: 403 })
  }
  if (error === SIGNED_OUT) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (error === NOT_FOUND) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json(
    { error: error ?? fallback, retryable: true },
    { status: 500 }
  )
}
