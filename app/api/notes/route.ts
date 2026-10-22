import { NextRequest, NextResponse } from 'next/server'

import { listNotes, type NotesListCursor, saveNote } from '@/lib/actions/notes'

import { noteErrorResponse, toNoteJson } from './note-response'

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 50
const MAX_CONTENT_LENGTH = 100_000

const INVALID_CURSOR = { error: 'Invalid cursor' }
const INVALID_NOTE = { error: 'Invalid note' }

// limit is clamped to [1, MAX_LIMIT]; a missing or unparseable one is the default.
function parseLimit(value: string | null): number {
  const n = parseInt(value ?? '', 10)
  if (Number.isNaN(n)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, n))
}

// The keyset cursor is both params or neither; a half cursor or an
// unparseable date is rejected rather than silently restarting at page one.
function parseCursor(
  params: URLSearchParams
): NotesListCursor | undefined | 'invalid' {
  const updatedAt = params.get('cursorUpdatedAt')
  const id = params.get('cursorId')
  if (!updatedAt && !id) return undefined
  if (!updatedAt || !id || Number.isNaN(Date.parse(updatedAt))) {
    return 'invalid'
  }
  return { updatedAt, id }
}

// GET /api/notes?limit&cursorUpdatedAt&cursorId: the user's notes, newest
// update first, keyset-paginated by (updatedAt, id).
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const cursor = parseCursor(searchParams)
  if (cursor === 'invalid') {
    return NextResponse.json(INVALID_CURSOR, { status: 400 })
  }

  let result: Awaited<ReturnType<typeof listNotes>>
  try {
    result = await listNotes({
      limit: parseLimit(searchParams.get('limit')),
      cursor
    })
  } catch (error) {
    console.error('GET /api/notes failed:', error)
    return noteErrorResponse(undefined, 'Failed to load notes.')
  }
  if (!result.success) {
    return noteErrorResponse(result.error, 'Failed to load notes.')
  }
  return NextResponse.json({
    notes: (result.notes ?? []).map(toNoteJson),
    nextCursor: result.nextCursor ?? null,
    hasMore: result.hasMore ?? false
  })
}

function optionalString(value: unknown): string | undefined | false {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : false
}

// POST /api/notes {content, title?, chatId?, sourceMessageId?} → 201 {note}.
// saveNote derives the title from the content when none is given.
export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(INVALID_NOTE, { status: 400 })
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json(INVALID_NOTE, { status: 400 })
  }

  const fields = body as Record<string, unknown>
  const { content } = fields
  const title = optionalString(fields.title)
  const chatId = optionalString(fields.chatId)
  const sourceMessageId = optionalString(fields.sourceMessageId)
  if (
    typeof content !== 'string' ||
    !content.trim() ||
    content.length > MAX_CONTENT_LENGTH ||
    title === false ||
    chatId === false ||
    sourceMessageId === false
  ) {
    return NextResponse.json(INVALID_NOTE, { status: 400 })
  }

  let result: Awaited<ReturnType<typeof saveNote>>
  try {
    result = await saveNote({ content, title, chatId, sourceMessageId })
  } catch (error) {
    console.error('POST /api/notes failed:', error)
    return noteErrorResponse(undefined, 'Failed to save note.')
  }
  if (!result.success || !result.note) {
    return noteErrorResponse(result.error, 'Failed to save note.')
  }
  return NextResponse.json({ note: toNoteJson(result.note) }, { status: 201 })
}
