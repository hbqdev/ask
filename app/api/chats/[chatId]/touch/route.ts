import { NextRequest } from 'next/server'

import { rejectInvalidBearer } from '@/lib/auth/reject-invalid-bearer'
import { touchChat } from '@/lib/db/actions'

// Bumps the chat's last_viewed_at for the "recent" sidebar order. touchChat is
// fire-and-forget: it resolves the user itself, silently skips guests and
// chats the user doesn't own, and never throws — so this answers 204, except
// for a present but invalid bearer, which gets a 401.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const rejected = await rejectInvalidBearer(request)
  if (rejected) return rejected

  const { chatId } = await params
  await touchChat(chatId)
  return new Response(null, { status: 204 })
}
