import { NextRequest, NextResponse } from 'next/server'

import { deleteChat } from '@/lib/actions/chat'

// Native-client counterpart of the web's deleteChat server action, which a
// bearer-token client cannot invoke. deleteChat resolves the user itself and
// checks ownership; a missing or foreign chat comes back as a plain failure
// and is reported as 404 so the response does not reveal whether it exists.
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const { chatId } = await params
  const result = await deleteChat(chatId)

  if (result.success) {
    return NextResponse.json({ ok: true })
  }
  if (result.error === 'User not authenticated') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json({ error: result.error }, { status: 404 })
}
