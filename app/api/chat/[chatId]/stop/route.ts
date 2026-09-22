import { loadChatUncached } from '@/lib/actions/chat'
import { getCurrentUserId } from '@/lib/auth/get-current-user'
import {
  stopGeneration,
  waitForStoppedTurn
} from '@/lib/streaming/active-generations'

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

  // The stopped turn saves its partial answer in onFinish; answer only once
  // that settled (bounded) so a caller that awaits Stop can rely on the
  // partial being persisted.
  if (stopGeneration(chatId)) await waitForStoppedTurn(chatId)
  return new Response(null, { status: 204 })
}
