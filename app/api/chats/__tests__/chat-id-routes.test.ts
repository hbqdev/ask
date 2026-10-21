import { NextRequest } from 'next/server'

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Auto-mocked; each test configures the resolved values it needs.
vi.mock('@/lib/actions/chat')
vi.mock('@/lib/db/actions')

import { deleteChat } from '@/lib/actions/chat'
import { touchChat } from '@/lib/db/actions'

import { DELETE } from '../[chatId]/route'
import { POST } from '../[chatId]/touch/route'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(touchChat).mockResolvedValue(undefined)
})

function context(chatId: string) {
  return { params: Promise.resolve({ chatId }) }
}

function makeRequest(path: string, method: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/chats/${path}`, { method })
}

describe('DELETE /api/chats/[chatId]', () => {
  it('returns 200 {ok:true} when the chat is deleted', async () => {
    vi.mocked(deleteChat).mockResolvedValue({ success: true })

    const res = await DELETE(makeRequest('c1', 'DELETE'), context('c1'))

    expect(deleteChat).toHaveBeenCalledWith('c1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('returns 401 when deleteChat reports no authenticated user', async () => {
    vi.mocked(deleteChat).mockResolvedValue({
      success: false,
      error: 'User not authenticated'
    })

    const res = await DELETE(makeRequest('c1', 'DELETE'), context('c1'))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 Not found when the chat is missing or not owned', async () => {
    vi.mocked(deleteChat).mockResolvedValue({
      success: false,
      error: 'Unauthorized'
    })

    const res = await DELETE(makeRequest('c2', 'DELETE'), context('c2'))

    expect(deleteChat).toHaveBeenCalledWith('c2')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('returns a retryable 500 when the delete itself failed', async () => {
    vi.mocked(deleteChat).mockResolvedValue({
      success: false,
      error: 'Failed to delete chat'
    })

    const res = await DELETE(makeRequest('c3', 'DELETE'), context('c3'))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to delete chat',
      retryable: true
    })
  })

  it('returns a retryable 500 when deleteChat throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(deleteChat).mockRejectedValue(new Error('db down'))

    const res = await DELETE(makeRequest('c4', 'DELETE'), context('c4'))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to delete chat',
      retryable: true
    })
    consoleError.mockRestore()
  })
})

describe('POST /api/chats/[chatId]/touch', () => {
  it('returns 204 and calls touchChat with the id', async () => {
    const res = await POST(makeRequest('c1/touch', 'POST'), context('c1'))

    expect(touchChat).toHaveBeenCalledWith('c1')
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })
})
