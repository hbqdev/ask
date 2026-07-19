import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { makeSessionToken } from '@/lib/auth'
import { proxy } from './proxy'

const req = (path: string, cookie?: string) => {
  const r = new NextRequest(new URL(`http://localhost${path}`))
  if (cookie) r.cookies.set('mm_session', cookie)
  return r
}

describe('proxy guard', () => {
  it('503 when password unset (fail-closed)', () => {
    delete process.env.MODEL_MANAGER_PASSWORD
    expect(proxy(req('/')).status).toBe(503)
  })
  it('redirects unauthenticated page requests to /login', () => {
    process.env.MODEL_MANAGER_PASSWORD = 'pw'
    const res = proxy(req('/'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/login')
  })
  it('401 for unauthenticated api requests', () => {
    process.env.MODEL_MANAGER_PASSWORD = 'pw'
    expect(proxy(req('/api/config')).status).toBe(401)
  })
  it('allows a valid session', () => {
    process.env.MODEL_MANAGER_PASSWORD = 'pw'
    const res = proxy(req('/api/config', makeSessionToken()))
    expect(res.status).toBe(200) // NextResponse.next()
  })
  it('always allows /login and /api/health', () => {
    process.env.MODEL_MANAGER_PASSWORD = 'pw'
    expect(proxy(req('/login')).status).toBe(200)
    expect(proxy(req('/api/health')).status).toBe(200)
  })
})
