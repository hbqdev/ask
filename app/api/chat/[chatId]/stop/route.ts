import { loadChatUncached } from '@/lib/actions/chat'
import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { stopGeneration } from '@/lib/streaming/active-generations'

// POST /api/chat/[chatId]/stop — explicit Stop. Decoupling the authenticated
// generation from req.signal (so a backgrounded mobile tab keeps generating)
// means the Stop button no longer halts the server by closing the connection.
// The client hits this to abort the running turn in-process.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const { chatId } = await params

  const userId = await getCurrentUserId()
  if (!userId) return new Response(null, { status: 401 })

  // Only the chat's owner may stop it. 204 (not 403) so existence isn't leaked.
  const chat = await loadChatUncached(chatId, userId)
  if (!chat || chat.userId !== userId) {
    return new Response(null, { status: 204 })
  }

  stopGeneration(chatId)
  return new Response(null, { status: 204 })
}
