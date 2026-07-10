import { NextRequest, NextResponse } from 'next/server'

import { getChatsPage } from '@/lib/actions/chat'
import type { ChatBadgeData, ChatSortOption } from '@/lib/db/actions'
import { Chat as DBChat } from '@/lib/db/schema'

interface ChatPageResponse {
  chats: DBChat[]
  nextOffset: number | null
  badges: Record<string, ChatBadgeData>
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

  try {
    const result = await getChatsPage(limit, offset, sort)
    return NextResponse.json<ChatPageResponse>(result)
  } catch (error) {
    console.error('API route error fetching chats:', error)
    return NextResponse.json<ChatPageResponse>(
      { chats: [], nextOffset: null, badges: {} },
      { status: 500 }
    )
  }
}
