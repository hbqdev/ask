import { NextRequest } from 'next/server'

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Auto-mocked; each test configures the resolved values it needs.
vi.mock('@/lib/actions/chat')

import { clearChats, countChats, getChatsPage } from '@/lib/actions/chat'

import { DELETE, GET } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getChatsPage).mockResolvedValue({
    chats: [],
    nextOffset: null,
    badges: {}
  })
  vi.mocked(countChats).mockResolvedValue(0)
})

function getRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/chats${query}`)
}

function deleteRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/chats', {
    method: 'DELETE'
  })
}

describe('GET /api/chats paging', () => {
  it('defaults to limit 20, offset 0, recent', async () => {
    const res = await GET(getRequest(''))

    expect(res.status).toBe(200)
    expect(getChatsPage).toHaveBeenCalledWith(20, 0, 'recent')
  })

  it('passes an in-range limit and offset through unchanged', async () => {
    await GET(getRequest('?limit=30&offset=60&sort=title'))

    expect(getChatsPage).toHaveBeenCalledWith(30, 60, 'title')
  })

  it.each([
    ['999', 50],
    ['51', 50],
    ['50', 50],
    ['0', 1],
    ['-3', 1],
    ['abc', 20]
  ])('clamps limit=%s to %d', async (limit, expected) => {
    await GET(getRequest(`?limit=${limit}`))

    expect(getChatsPage).toHaveBeenCalledWith(expected, 0, 'recent')
  })

  it.each(['-5', 'abc'])('treats offset=%s as 0', async offset => {
    await GET(getRequest(`?offset=${offset}&limit=10`))

    expect(getChatsPage).toHaveBeenCalledWith(10, 0, 'recent')
  })
})

describe('DELETE /api/chats', () => {
  it('returns 200 {ok:true} after clearing every chat', async () => {
    vi.mocked(clearChats).mockResolvedValue({ success: true })

    const res = await DELETE(deleteRequest())

    expect(clearChats).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('returns 401 when clearChats reports no authenticated user', async () => {
    vi.mocked(clearChats).mockResolvedValue({
      success: false,
      error: 'User not authenticated'
    })

    const res = await DELETE(deleteRequest())

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('returns a retryable 500 when the delete failed', async () => {
    vi.mocked(clearChats).mockResolvedValue({
      success: false,
      error: 'Failed to delete user chats'
    })

    const res = await DELETE(deleteRequest())

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to delete user chats',
      retryable: true
    })
  })

  it('returns a retryable 500 when clearChats throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(clearChats).mockRejectedValue(new Error('db down'))

    const res = await DELETE(deleteRequest())

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to clear chats',
      retryable: true
    })
    consoleError.mockRestore()
  })
})
