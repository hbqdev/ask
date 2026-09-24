import { NextRequest } from 'next/server'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getUser = vi.fn()
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser } })
}))
vi.mock('../keys', () => ({ getSupabasePublishableKey: () => 'pk' }))

import { isPublicPath, updateSession } from '../middleware'

describe('isPublicPath', () => {
  it("matches '/' exactly — it no longer makes every path public", () => {
    expect(isPublicPath('/')).toBe(true)
    expect(isPublicPath('/settings')).toBe(false)
    expect(isPublicPath('/some/new/page')).toBe(false)
  })

  it('keeps the intentionally-anonymous routes public', () => {
    for (const p of [
      '/auth',
      '/auth/login',
      '/share/abc',
      '/api/chat',
      '/search',
      '/search/123',
      '/discover',
      '/library',
      '/uploads/u/chats/c/f.png'
    ]) {
      expect(isPublicPath(p)).toBe(true)
    }
  })

  it('matches prefixes on a segment boundary only', () => {
    expect(isPublicPath('/authx')).toBe(false)
    expect(isPublicPath('/apiary')).toBe(false)
    expect(isPublicPath('/searching')).toBe(false)
  })
})

describe('updateSession redirect', () => {
  const env = { ...process.env }
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
    delete process.env.ENABLE_AUTH
    getUser.mockReset()
  })
  afterEach(() => {
    process.env = { ...env }
  })

  const req = (path: string) =>
    new NextRequest(new URL(`http://localhost${path}`))

  it('redirects an anonymous visitor on a non-public path to /auth/login', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await updateSession(req('/private-page'))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/auth/login')
  })

  it('lets an anonymous visitor through on the homepage and public routes', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    for (const p of ['/', '/search/abc', '/api/chat']) {
      const res = await updateSession(req(p))
      expect(res.headers.get('location')).toBeNull()
    }
  })

  it('never redirects a signed-in user', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
    const res = await updateSession(req('/private-page'))
    expect(res.headers.get('location')).toBeNull()
  })

  it('never redirects in anonymous mode (ENABLE_AUTH=false)', async () => {
    process.env.ENABLE_AUTH = 'false'
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await updateSession(req('/private-page'))
    expect(res.headers.get('location')).toBeNull()
  })
})
