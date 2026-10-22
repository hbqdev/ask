import { beforeEach, describe, expect, it, vi } from 'vitest'

// Auto-mocked; each test configures the resolved values it needs.
vi.mock('@/lib/actions/chat')
vi.mock('@/lib/auth/get-current-user')

import { loadChatUncached } from '@/lib/actions/chat'
import { getCurrentUserId } from '@/lib/auth/get-current-user'
import type { UIMessage } from '@/lib/types/ai'

import { GET } from '../route'

const messages: UIMessage[] = [
  { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }
]

function chat(userId: string) {
  return {
    id: 'c1',
    title: 'Trip plan',
    userId,
    visibility: 'public' as const,
    createdAt: new Date(),
    lastViewedAt: null,
    messages
  }
}

function context(chatId: string) {
  return { params: Promise.resolve({ chatId }) }
}

function request(): Request {
  return new Request('http://localhost:3000/api/chat/c1/messages')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/chat/[chatId]/messages', () => {
  it('returns the messages with the chat title and visibility', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue('user-1')
    vi.mocked(loadChatUncached).mockResolvedValue(chat('user-1'))

    const res = await GET(request(), context('c1'))

    expect(loadChatUncached).toHaveBeenCalledWith('c1', 'user-1')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({
      messages,
      title: 'Trip plan',
      visibility: 'public'
    })
  })

  it('returns 401 when there is no user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

    const res = await GET(request(), context('c1'))

    expect(res.status).toBe(401)
    expect(loadChatUncached).not.toHaveBeenCalled()
  })

  it('returns 404 for a missing chat', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue('user-1')
    vi.mocked(loadChatUncached).mockResolvedValue(null)

    const res = await GET(request(), context('c1'))

    expect(res.status).toBe(404)
  })

  it('returns 404 for a chat owned by someone else', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue('user-1')
    vi.mocked(loadChatUncached).mockResolvedValue(chat('user-2'))

    const res = await GET(request(), context('c1'))

    expect(res.status).toBe(404)
  })
})
