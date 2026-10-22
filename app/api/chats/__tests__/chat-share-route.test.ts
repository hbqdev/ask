import { NextRequest } from 'next/server'

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Auto-mocked; each test configures the resolved values it needs.
vi.mock('@/lib/actions/chat')
vi.mock('@/lib/db/actions')
vi.mock('@/lib/auth/get-current-user')
vi.mock('@/lib/utils/url')

import { shareChat, unshareChat } from '@/lib/actions/chat'
import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { updateChatVisibility } from '@/lib/db/actions'
import type { Chat } from '@/lib/db/schema'
import { getBaseUrl } from '@/lib/utils/url'

import { DELETE, POST } from '../[chatId]/share/route'

function chat(visibility: 'public' | 'private'): Chat {
  return {
    id: 'c1',
    title: 'Trip plan',
    userId: 'user-1',
    visibility,
    createdAt: new Date(),
    lastViewedAt: null
  }
}

function context(chatId: string) {
  return { params: Promise.resolve({ chatId }) }
}

// The request arrives on the internal host; the share URL must not use it.
function makeRequest(chatId: string, method: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/chats/${chatId}/share`, {
    method
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCurrentUserId).mockResolvedValue('user-1')
  vi.mocked(getBaseUrl).mockResolvedValue(new URL('https://ask.example.com'))
})

describe('POST /api/chats/[chatId]/share', () => {
  it('shares the chat and returns the public URL on the base URL', async () => {
    vi.mocked(shareChat).mockResolvedValue(chat('public'))

    const res = await POST(makeRequest('c1', 'POST'), context('c1'))

    expect(shareChat).toHaveBeenCalledWith('c1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      url: 'https://ask.example.com/search/c1',
      visibility: 'public'
    })
  })

  it('returns 401 without sharing when there is no user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

    const res = await POST(makeRequest('c1', 'POST'), context('c1'))

    expect(shareChat).not.toHaveBeenCalled()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 for a missing or foreign chat', async () => {
    vi.mocked(shareChat).mockResolvedValue(null)

    const res = await POST(makeRequest('c2', 'POST'), context('c2'))

    expect(shareChat).toHaveBeenCalledWith('c2')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('returns a retryable 500 when sharing throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(shareChat).mockRejectedValue(new Error('db down'))

    const res = await POST(makeRequest('c1', 'POST'), context('c1'))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to share chat',
      retryable: true
    })
    consoleError.mockRestore()
  })
})

describe('DELETE /api/chats/[chatId]/share', () => {
  it('makes the chat private', async () => {
    vi.mocked(unshareChat).mockResolvedValue(chat('private'))

    const res = await DELETE(makeRequest('c1', 'DELETE'), context('c1'))

    expect(unshareChat).toHaveBeenCalledWith('c1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, visibility: 'private' })
  })

  it('is idempotent: unsharing twice succeeds both times', async () => {
    // Real unshareChat over the mocked DB layer: an already-private chat is
    // still the owner's, so the second call is a 200 too.
    const actual =
      await vi.importActual<typeof import('@/lib/actions/chat')>(
        '@/lib/actions/chat'
      )
    vi.mocked(unshareChat).mockImplementation(actual.unshareChat)
    vi.mocked(updateChatVisibility).mockResolvedValue(chat('private'))

    const first = await DELETE(makeRequest('c1', 'DELETE'), context('c1'))
    const second = await DELETE(makeRequest('c1', 'DELETE'), context('c1'))

    expect(updateChatVisibility).toHaveBeenCalledTimes(2)
    expect(updateChatVisibility).toHaveBeenCalledWith('c1', 'user-1', 'private')
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ ok: true, visibility: 'private' })
  })

  it('returns 401 without unsharing when there is no user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

    const res = await DELETE(makeRequest('c1', 'DELETE'), context('c1'))

    expect(unshareChat).not.toHaveBeenCalled()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 for a missing or foreign chat', async () => {
    vi.mocked(unshareChat).mockResolvedValue(null)

    const res = await DELETE(makeRequest('c2', 'DELETE'), context('c2'))

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('returns a retryable 500 when unsharing throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(unshareChat).mockRejectedValue(new Error('db down'))

    const res = await DELETE(makeRequest('c1', 'DELETE'), context('c1'))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to unshare chat',
      retryable: true
    })
    consoleError.mockRestore()
  })
})
