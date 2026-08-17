import { NextRequest, NextResponse } from 'next/server'

import { countChats, getChatsPage } from '@/lib/actions/chat'
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

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const offset = parseInt(searchParams.get('offset') || '0', 10)
  const limit = parseInt(searchParams.get('limit') || '20', 10)
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
