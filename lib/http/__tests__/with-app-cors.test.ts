import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appPreflight, withAppCors } from '@/lib/http/with-app-cors'

const APP = 'capacitor://localhost'

describe('withAppCors', () => {
  beforeEach(() => vi.stubEnv('APP_CORS_ORIGINS', ''))
  afterEach(() => vi.unstubAllEnvs())

  it('adds the app CORS headers for an allowed origin and keeps status, headers and body', async () => {
    const res = withAppCors(
      new Response('{"ok":true}', {
        status: 201,
        headers: { 'Content-Type': 'application/json', Vary: 'Accept' }
      }),
      APP
    )

    expect(res.status).toBe(201)
    expect(res.headers.get('access-control-allow-origin')).toBe(APP)
    expect(res.headers.get('access-control-allow-headers')).toBe(
      'Authorization, Content-Type, x-filename, x-chat-id'
    )
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('vary')).toBe('Accept, Origin')
    expect(await res.text()).toBe('{"ok":true}')
  })

  it('adds nothing for a foreign or missing origin', () => {
    const foreign = withAppCors(new Response('x'), 'https://evil.example')
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull()

    const none = withAppCors(new Response('x'), null)
    expect(none.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('honours APP_CORS_ORIGINS', () => {
    vi.stubEnv('APP_CORS_ORIGINS', 'http://localhost:5173')
    const res = withAppCors(new Response('x'), 'http://localhost:5173')
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:5173'
    )
    expect(
      withAppCors(new Response('x'), APP).headers.get(
        'access-control-allow-origin'
      )
    ).toBeNull()
  })
})

describe('appPreflight', () => {
  beforeEach(() => vi.stubEnv('APP_CORS_ORIGINS', ''))
  afterEach(() => vi.unstubAllEnvs())

  const preflight = (origin?: string) =>
    new Request('https://ask.test/api/upload', {
      method: 'OPTIONS',
      headers: {
        ...(origin ? { Origin: origin } : {}),
        'Access-Control-Request-Method': 'POST'
      }
    })

  it('answers 204 with the CORS headers for an allowed origin', async () => {
    const res = appPreflight(preflight(APP))
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(APP)
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    expect(res.headers.get('access-control-max-age')).toBe('600')
    expect(await res.text()).toBe('')
  })

  it('answers 204 without CORS headers for a foreign or missing origin', () => {
    const foreign = appPreflight(preflight('https://evil.example'))
    expect(foreign.status).toBe(204)
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull()

    const none = appPreflight(preflight())
    expect(none.status).toBe(204)
    expect(none.headers.get('access-control-allow-origin')).toBeNull()
  })
})
