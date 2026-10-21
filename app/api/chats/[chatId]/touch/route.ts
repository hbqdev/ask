import { NextRequest } from 'next/server'

import { touchChat } from '@/lib/db/actions'

// Bumps the chat's last_viewed_at for the "recent" sidebar order. touchChat is
// fire-and-forget: it resolves the user itself, silently skips guests and
// chats the user doesn't own, and never throws — so this always answers 204.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const { chatId } = await params
  await touchChat(chatId)
  return new Response(null, { status: 204 })
}
