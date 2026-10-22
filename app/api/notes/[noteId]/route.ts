import { NextRequest, NextResponse } from 'next/server'

import { deleteNote, getNote } from '@/lib/actions/notes'

import { noteErrorResponse, toNoteJson } from '../note-response'

type Context = { params: Promise<{ noteId: string }> }

// GET /api/notes/{id} → {note}. A missing or foreign note is 404.
export async function GET(_request: NextRequest, { params }: Context) {
  const { noteId } = await params
  let result: Awaited<ReturnType<typeof getNote>>
  try {
    result = await getNote(noteId)
  } catch (error) {
    console.error('GET /api/notes/[noteId] failed:', error)
    return noteErrorResponse(undefined, 'Failed to load note.')
  }
  if (!result.success) {
    return noteErrorResponse(result.error, 'Failed to load note.')
  }
  if (!result.note) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json({ note: toNoteJson(result.note) })
}

// DELETE /api/notes/{id} → {ok:true}. A missing or foreign note is 404.
export async function DELETE(_request: NextRequest, { params }: Context) {
  const { noteId } = await params
  let result: Awaited<ReturnType<typeof deleteNote>>
  try {
    result = await deleteNote(noteId)
  } catch (error) {
    console.error('DELETE /api/notes/[noteId] failed:', error)
    return noteErrorResponse(undefined, 'Failed to delete note')
  }
  if (!result.success) {
    return noteErrorResponse(result.error, 'Failed to delete note')
  }
  return NextResponse.json({ ok: true })
}
