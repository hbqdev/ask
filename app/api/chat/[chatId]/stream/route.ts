import { UI_MESSAGE_STREAM_HEADERS } from 'ai'

import { loadChatUncached } from '@/lib/actions/chat'
import { getCurrentUserId } from '@/lib/auth/get-current-user'
import {
  getActiveStreamId,
  getResumableStreamContext
} from '@/lib/streaming/resumable-stream-context'

// GET /api/chat/[chatId]/stream — the resume endpoint the AI SDK's
// `useChat({ resume })` / DefaultChatTransport.reconnectToStream hits. Returns
// the live resumable stream when one is active for this chat, otherwise 204
// (which the SDK treats as "nothing to resume" → no-op, and the client falls
// back to the persisted message).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const { chatId } = await params

  const userId = await getCurrentUserId()
  if (!userId) return new Response(null, { status: 401 })

  // Never resume a stream for a chat the caller does not own — a resumed stream
  // replays private content. 204 (not 403) so existence isn't revealed.
  const chat = await loadChatUncached(chatId, userId)
  if (!chat || chat.userId !== userId) {
    return new Response(null, { status: 204 })
  }

  const streamId = await getActiveStreamId(chatId)
  if (!streamId) return new Response(null, { status: 204 })

  const rsc = await getResumableStreamContext()
  const resumed = rsc ? await rsc.resumeExistingStream(streamId) : null
  if (!resumed) return new Response(null, { status: 204 })

  return new Response(resumed, { headers: UI_MESSAGE_STREAM_HEADERS })
}
