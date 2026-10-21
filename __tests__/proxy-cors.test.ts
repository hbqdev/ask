import { NextRequest, NextResponse } from 'next/server'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const updateSession = vi.fn(async () => NextResponse.next())

vi.mock('@/lib/supabase/middleware', () => ({
  updateSession: (...args: unknown[]) =>
    (updateSession as (...a: unknown[]) => Promise<NextResponse>)(...args)
}))

import { proxy } from '@/proxy'

const APP = 'capacitor://localhost'
const BASE = 'https://ask.hbqnexus.win'

describe('proxy CORS for the app origin', () => {
  beforeEach(() => {
    updateSession.mockClear()
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.test')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'pk-test')
    vi.stubEnv('APP_CORS_ORIGINS', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('answers an allowed-origin preflight to /api/chat with 204 and CORS headers without calling updateSession', async () => {
    const res = await proxy(
      new NextRequest(`${BASE}/api/chat`, {
        method: 'OPTIONS',
        headers: {
          Origin: APP,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization, content-type'
        }
      })
    )

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(APP)
    expect(res.headers.get('access-control-allow-methods')).toBe(
      'GET, POST, PUT, PATCH, DELETE, OPTIONS'
    )
    expect(res.headers.get('access-control-allow-headers')).toBe(
      'Authorization, Content-Type, x-filename, x-chat-id'
    )
    expect(res.headers.get('access-control-max-age')).toBe('600')
    expect(res.headers.get('vary')).toContain('Origin')
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
    expect(updateSession).not.toHaveBeenCalled()
  })

  it('answers a disallowed-origin preflight to /api with 204 and no CORS headers', async () => {
    const res = await proxy(
      new NextRequest(`${BASE}/api/chat`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'POST'
        }
      })
    )

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(updateSession).not.toHaveBeenCalled()
  })

  it('adds CORS headers to an allowed-origin GET /api/chats', async () => {
    const res = await proxy(
      new NextRequest(`${BASE}/api/chats`, {
        method: 'GET',
        headers: { Origin: APP, Authorization: 'Bearer abc' }
      })
    )

    expect(updateSession).toHaveBeenCalledTimes(1)
    expect(res.headers.get('access-control-allow-origin')).toBe(APP)
    expect(res.headers.get('access-control-expose-headers')).toBe(
      'x-vercel-ai-ui-message-stream, Content-Type'
    )
    expect(res.headers.get('vary')).toContain('Origin')
    // existing proxy behaviour is preserved
    expect(res.headers.get('x-url')).toBe(`${BASE}/api/chats`)
  })

  it('leaves non-/api paths and disallowed origins without CORS headers', async () => {
    const page = await proxy(
      new NextRequest(`${BASE}/search/abc`, {
        method: 'GET',
        headers: { Origin: APP }
      })
    )
    expect(page.headers.get('access-control-allow-origin')).toBeNull()

    const evil = await proxy(
      new NextRequest(`${BASE}/api/chats`, {
        method: 'GET',
        headers: { Origin: 'https://evil.example' }
      })
    )
    expect(evil.headers.get('access-control-allow-origin')).toBeNull()
    expect(evil.headers.get('access-control-allow-methods')).toBeNull()

    const sameOrigin = await proxy(
      new NextRequest(`${BASE}/api/chats`, { method: 'GET' })
    )
    expect(sameOrigin.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('does not short-circuit an OPTIONS preflight to a non-/api path', async () => {
    await proxy(
      new NextRequest(`${BASE}/search/abc`, {
        method: 'OPTIONS',
        headers: { Origin: APP, 'Access-Control-Request-Method': 'GET' }
      })
    )
    expect(updateSession).toHaveBeenCalledTimes(1)
  })
})
