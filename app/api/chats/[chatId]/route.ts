import { NextRequest, NextResponse } from 'next/server'

import { deleteChat, renameChat } from '@/lib/actions/chat'

const DELETE_FAILED = { error: 'Failed to delete chat', retryable: true }
const RENAME_FAILED = { error: 'Failed to rename chat', retryable: true }
const TITLE_REQUIRED = { error: 'Title is required' }

// Native-client counterpart of the web's deleteChat server action, which a
// bearer-token client cannot invoke. deleteChat resolves the user itself and
// checks ownership. A missing or foreign chat is reported as 404 Not found so
// the response does not reveal whether it exists; a database failure (reported
// or thrown) is a retryable 500.
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const { chatId } = await params

  let result: Awaited<ReturnType<typeof deleteChat>>
  try {
    result = await deleteChat(chatId)
  } catch (error) {
    console.error('DELETE /api/chats/[chatId] failed:', error)
    return NextResponse.json(DELETE_FAILED, { status: 500 })
  }

  if (result.success) {
    return NextResponse.json({ ok: true })
  }
  if (result.error === 'User not authenticated') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (result.error === 'Failed to delete chat') {
    return NextResponse.json(DELETE_FAILED, { status: 500 })
  }
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

// Native-client rename (the web has no user rename). Body: {title: string}.
// renameChat resolves the user itself, trims, rejects an empty title and
// truncates an over-long one to CHAT_TITLE_MAX_LENGTH; the response carries the
// title as saved. Status mapping mirrors DELETE above.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const { chatId } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(TITLE_REQUIRED, { status: 400 })
  }
  const title =
    body && typeof body === 'object'
      ? (body as { title?: unknown }).title
      : undefined
  if (typeof title !== 'string') {
    return NextResponse.json(TITLE_REQUIRED, { status: 400 })
  }

  let result: Awaited<ReturnType<typeof renameChat>>
  try {
    result = await renameChat(chatId, title)
  } catch (error) {
    console.error('PATCH /api/chats/[chatId] failed:', error)
    return NextResponse.json(RENAME_FAILED, { status: 500 })
  }

  if ('ok' in result) {
    return NextResponse.json({ ok: true, title: result.title })
  }
  if (result.error === 'User not authenticated') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (result.error === 'Empty title') {
    return NextResponse.json(TITLE_REQUIRED, { status: 400 })
  }
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
