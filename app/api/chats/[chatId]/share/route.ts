import { NextRequest, NextResponse } from 'next/server'

import { shareChat, unshareChat } from '@/lib/actions/chat'
import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { getBaseUrl } from '@/lib/utils/url'

const UNAUTHORIZED = { error: 'Unauthorized' }
const NOT_FOUND = { error: 'Not found' }
const SHARE_FAILED = { error: 'Failed to share chat', retryable: true }
const UNSHARE_FAILED = { error: 'Failed to unshare chat', retryable: true }

type Context = { params: Promise<{ chatId: string }> }

// Native-client counterparts of the web's share action. shareChat/unshareChat
// resolve the user themselves and check ownership, returning null for both "no
// user" and "missing or foreign chat"; the user is checked first only to tell
// those apart (401 vs 404). A foreign chat is 404 so its existence stays hidden.

// POST: make the chat public. The URL is built on getBaseUrl() (BASE_URL env
// first), never the request host, which is internal behind the proxy.
export async function POST(_request: NextRequest, { params }: Context) {
  const { chatId } = await params
  try {
    if (!(await getCurrentUserId())) {
      return NextResponse.json(UNAUTHORIZED, { status: 401 })
    }
    const chat = await shareChat(chatId)
    if (!chat) {
      return NextResponse.json(NOT_FOUND, { status: 404 })
    }
    const url = new URL(
      `/search/${encodeURIComponent(chatId)}`,
      await getBaseUrl()
    ).toString()
    return NextResponse.json({ ok: true, url, visibility: 'public' })
  } catch (error) {
    console.error('POST /api/chats/[chatId]/share failed:', error)
    return NextResponse.json(SHARE_FAILED, { status: 500 })
  }
}

// DELETE: make the chat private again. Idempotent: unsharing a private chat
// succeeds.
export async function DELETE(_request: NextRequest, { params }: Context) {
  const { chatId } = await params
  try {
    if (!(await getCurrentUserId())) {
      return NextResponse.json(UNAUTHORIZED, { status: 401 })
    }
    const chat = await unshareChat(chatId)
    if (!chat) {
      return NextResponse.json(NOT_FOUND, { status: 404 })
    }
    return NextResponse.json({ ok: true, visibility: 'private' })
  } catch (error) {
    console.error('DELETE /api/chats/[chatId]/share failed:', error)
    return NextResponse.json(UNSHARE_FAILED, { status: 500 })
  }
}
