import { loadChatUncached } from '@/lib/actions/chat'
import { getCurrentUserId } from '@/lib/auth/get-current-user'

// GET /api/chat/[chatId]/messages — the persisted conversation, read straight
// from the DB (never the stale-while-revalidate `loadChat` cache). Used by the
// client when a resume finds no live stream (the turn finished while it was
// away): it swaps the stale partial on screen for the saved answer without a
// route refresh (which would remount a home-started chat). The chat's title and
// visibility ride along for clients that open a chat with no list row (the iOS
// app from a deep link).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const { chatId } = await params

  const userId = await getCurrentUserId()
  if (!userId) return new Response(null, { status: 401 })

  // Owner only; 404 for both missing and foreign chats so existence isn't leaked.
  const chat = await loadChatUncached(chatId, userId)
  if (!chat || chat.userId !== userId) {
    return new Response(null, { status: 404 })
  }

  return Response.json(
    { messages: chat.messages, title: chat.title, visibility: chat.visibility },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
