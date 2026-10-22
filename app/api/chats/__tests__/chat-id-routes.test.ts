import { NextRequest } from 'next/server'

import type { User } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Auto-mocked; each test configures the resolved values it needs.
vi.mock('@/lib/actions/chat')
vi.mock('@/lib/db/actions')
// Real isBearerAuthorization; the user resolution is stubbed.
vi.mock('@/lib/auth/get-current-user', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/auth/get-current-user')>()),
  getCurrentUser: vi.fn(),
  getCurrentUserId: vi.fn()
}))

import { deleteChat, renameChat } from '@/lib/actions/chat'
import { getCurrentUser, getCurrentUserId } from '@/lib/auth/get-current-user'
import { touchChat, updateChatTitle } from '@/lib/db/actions'
import { CHAT_TITLE_MAX_LENGTH } from '@/lib/db/schema'

import { DELETE, PATCH } from '../[chatId]/route'
import { POST } from '../[chatId]/touch/route'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(touchChat).mockResolvedValue(undefined)
  vi.stubEnv('ENABLE_AUTH', 'true')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function context(chatId: string) {
  return { params: Promise.resolve({ chatId }) }
}

function makeRequest(
  path: string,
  method: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(`http://localhost:3000/api/chats/${path}`, {
    method,
    headers
  })
}

function patchRequest(body: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/chats/c1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body
  })
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
    expect(getCurrentUser).not.toHaveBeenCalled()
  })

  it('401 for an invalid bearer', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)

    const res = await POST(
      makeRequest('c1/touch', 'POST', { authorization: 'Bearer bad' }),
      context('c1')
    )

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expect(touchChat).not.toHaveBeenCalled()
  })

  it('a valid bearer touches the chat and answers 204 as before', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user-1' } as User)

    const res = await POST(
      makeRequest('c1/touch', 'POST', { authorization: 'Bearer good' }),
      context('c1')
    )

    expect(touchChat).toHaveBeenCalledWith('c1')
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })
})

describe('PATCH /api/chats/[chatId]', () => {
  it('returns 200 {ok:true, title} with the trimmed title', async () => {
    vi.mocked(renameChat).mockResolvedValue({ ok: true, title: 'Trip plan' })

    const res = await PATCH(
      patchRequest(JSON.stringify({ title: '  Trip plan  ' })),
      context('c1')
    )

    expect(renameChat).toHaveBeenCalledWith('c1', '  Trip plan  ')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, title: 'Trip plan' })
  })

  it('saves a 300-char title capped at CHAT_TITLE_MAX_LENGTH', async () => {
    // Real renameChat over the mocked DB layer: the cap is applied before the
    // write, and the response carries the title that was actually saved.
    const actual =
      await vi.importActual<typeof import('@/lib/actions/chat')>(
        '@/lib/actions/chat'
      )
    vi.mocked(renameChat).mockImplementation(actual.renameChat)
    vi.mocked(getCurrentUserId).mockResolvedValue('user-1')
    const capped = 'x'.repeat(CHAT_TITLE_MAX_LENGTH)
    vi.mocked(updateChatTitle).mockResolvedValue({
      id: 'c1',
      title: capped,
      userId: 'user-1',
      visibility: 'private',
      createdAt: new Date(),
      lastViewedAt: null
    })

    const res = await PATCH(
      patchRequest(JSON.stringify({ title: 'x'.repeat(300) })),
      context('c1')
    )

    expect(updateChatTitle).toHaveBeenCalledWith('c1', capped, 'user-1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, title: capped })
  })

  it.each([
    ['an empty title', JSON.stringify({ title: '' })],
    ['a whitespace title', JSON.stringify({ title: '   ' })]
  ])('returns 400 for %s', async (_label, body) => {
    vi.mocked(renameChat).mockResolvedValue({ error: 'Empty title' })

    const res = await PATCH(patchRequest(body), context('c1'))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Title is required' })
  })

  it.each([
    ['a non-string title', JSON.stringify({ title: 42 })],
    ['a missing title', JSON.stringify({})],
    ['a non-object body', JSON.stringify('Trip plan')],
    ['a null body', 'null'],
    ['malformed JSON', '{not json']
  ])('returns 400 without renaming for %s', async (_label, body) => {
    const res = await PATCH(patchRequest(body), context('c1'))

    expect(renameChat).not.toHaveBeenCalled()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Title is required' })
  })

  it('returns 401 when renameChat reports no authenticated user', async () => {
    vi.mocked(renameChat).mockResolvedValue({
      error: 'User not authenticated'
    })

    const res = await PATCH(
      patchRequest(JSON.stringify({ title: 'Trip plan' })),
      context('c1')
    )

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when the chat is missing or not owned', async () => {
    vi.mocked(renameChat).mockResolvedValue({ error: 'Not found' })

    const res = await PATCH(
      patchRequest(JSON.stringify({ title: 'Trip plan' })),
      context('c1')
    )

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('returns a retryable 500 when renameChat throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(renameChat).mockRejectedValue(new Error('db down'))

    const res = await PATCH(
      patchRequest(JSON.stringify({ title: 'Trip plan' })),
      context('c1')
    )

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to rename chat',
      retryable: true
    })
    consoleError.mockRestore()
  })
})
