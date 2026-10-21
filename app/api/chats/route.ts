import { NextRequest, NextResponse } from 'next/server'

import { clearChats, countChats, getChatsPage } from '@/lib/actions/chat'
import type { ChatBadgeData, ChatSortOption } from '@/lib/db/actions'
import { Chat as DBChat } from '@/lib/db/schema'

interface ChatPageResponse {
  chats: DBChat[]
  nextOffset: number | null
  badges: Record<string, ChatBadgeData>
  // Real COUNT(*) of the user's chats. Returned only when the caller passes
  // `?withCount=1` (the first-page request); omitted on subsequent pages.
  total?: number
}

const VALID_SORTS: ChatSortOption[] = ['recent', 'newest', 'oldest', 'title']

function parseSort(value: string | null): ChatSortOption {
  return VALID_SORTS.includes(value as ChatSortOption)
    ? (value as ChatSortOption)
    : 'recent'
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

// limit is clamped to [1, MAX_LIMIT]; a missing or unparseable one is the default.
function parseLimit(value: string | null): number {
  const n = parseInt(value ?? '', 10)
  if (Number.isNaN(n)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, n))
}

// A missing, negative or unparseable offset is 0.
function parseOffset(value: string | null): number {
  const n = parseInt(value ?? '', 10)
  return Number.isNaN(n) || n < 0 ? 0 : n
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const offset = parseOffset(searchParams.get('offset'))
  const limit = parseLimit(searchParams.get('limit'))
  const sort = parseSort(searchParams.get('sort'))
  const withCount = searchParams.get('withCount') === '1'

  try {
    // The count runs alongside the first page (one round-trip) but fails open:
    // a count error leaves `total` undefined so the client falls back to the
    // loaded-rows count instead of taking down the whole page.
    const [result, total] = await Promise.all([
      getChatsPage(limit, offset, sort),
      withCount
        ? countChats().catch(error => {
            console.error('API route error counting chats:', error)
            return undefined
          })
        : Promise.resolve(undefined)
    ])
    return NextResponse.json<ChatPageResponse>(
      total === undefined ? result : { ...result, total }
    )
  } catch (error) {
    console.error('API route error fetching chats:', error)
    return NextResponse.json<ChatPageResponse>(
      { chats: [], nextOffset: null, badges: {} },
      { status: 500 }
    )
  }
}

// DELETE /api/chats: delete every chat of the current user. Native-client
// counterpart of the web's clearChats server action, which a bearer-token
// client cannot invoke; clearChats resolves the user itself.
export async function DELETE(_request: NextRequest) {
  let result: Awaited<ReturnType<typeof clearChats>>
  try {
    result = await clearChats()
  } catch (error) {
    console.error('DELETE /api/chats failed:', error)
    return NextResponse.json(
      { error: 'Failed to clear chats', retryable: true },
      { status: 500 }
    )
  }

  if (result.success) {
    return NextResponse.json({ ok: true })
  }
  if (result.error === 'User not authenticated') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json(
    { error: result.error ?? 'Failed to clear chats', retryable: true },
    { status: 500 }
  )
}
