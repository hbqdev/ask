import { NextRequest, NextResponse } from 'next/server'

import { deleteChat } from '@/lib/actions/chat'

const DELETE_FAILED = { error: 'Failed to delete chat', retryable: true }

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
