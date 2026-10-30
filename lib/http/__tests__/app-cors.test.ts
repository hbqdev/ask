import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  allowedAppOrigins,
  appCorsHeaders,
  isCorsPreflight
} from '@/lib/http/app-cors'

const APP = 'capacitor://localhost'
const ANDROID_APP = 'https://localhost'

describe('allowedAppOrigins', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to the Capacitor app origins', () => {
    vi.stubEnv('APP_CORS_ORIGINS', '')
    expect(allowedAppOrigins()).toEqual([APP, ANDROID_APP])
  })

  it('defaults when APP_CORS_ORIGINS is absent from the given env', () => {
    expect(allowedAppOrigins({} as NodeJS.ProcessEnv)).toEqual([
      APP,
      ANDROID_APP
    ])
  })

  it('allows the Android app origin by default', () => {
    const defaults = allowedAppOrigins({} as NodeJS.ProcessEnv)
    expect(defaults).toEqual(['capacitor://localhost', 'https://localhost'])
    expect(
      appCorsHeaders('https://localhost', defaults)?.[
        'Access-Control-Allow-Origin'
      ]
    ).toBe('https://localhost')
  })

  it('still refuses other https origins', () => {
    expect(
      appCorsHeaders(
        'https://evil.example',
        allowedAppOrigins({} as NodeJS.ProcessEnv)
      )
    ).toBeNull()
  })

  it('splits APP_CORS_ORIGINS on commas, trims, and drops empty entries', () => {
    vi.stubEnv(
      'APP_CORS_ORIGINS',
      ' capacitor://localhost, http://localhost:5173 ,'
    )
    expect(allowedAppOrigins()).toEqual([APP, 'http://localhost:5173'])
  })

  it('reads from an explicit env argument', () => {
    expect(
      allowedAppOrigins({
        APP_CORS_ORIGINS: 'http://a.test'
      } as unknown as NodeJS.ProcessEnv)
    ).toEqual(['http://a.test'])
  })
})

describe('appCorsHeaders', () => {
  it('echoes only the allowed origin', () => {
    const headers = appCorsHeaders(APP, [APP, 'http://localhost:5173'])
    expect(headers).toEqual({
      'Access-Control-Allow-Origin': APP,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':
        'Authorization, Content-Type, x-filename, x-chat-id',
      'Access-Control-Expose-Headers':
        'x-vercel-ai-ui-message-stream, Content-Type',
      'Access-Control-Max-Age': '600'
    })
  })

  it('does not set CORS headers for an origin outside the allow-list', () => {
    expect(appCorsHeaders('https://evil.example', [APP])).toBeNull()
  })

  it('returns null when there is no origin', () => {
    expect(appCorsHeaders(null, [APP])).toBeNull()
  })

  it('never allows credentials and never uses a wildcard', () => {
    const headers = appCorsHeaders(APP, [APP])!
    expect(headers['Access-Control-Allow-Credentials']).toBeUndefined()
    expect(Object.values(headers)).not.toContain('*')
  })
})

describe('isCorsPreflight', () => {
  it('is true for OPTIONS with Origin and Access-Control-Request-Method', () => {
    const headers = new Headers({
      Origin: APP,
      'Access-Control-Request-Method': 'POST'
    })
    expect(isCorsPreflight('OPTIONS', headers)).toBe(true)
  })

  it('is false for OPTIONS without Access-Control-Request-Method', () => {
    expect(isCorsPreflight('OPTIONS', new Headers({ Origin: APP }))).toBe(false)
  })

  it('is false for OPTIONS without Origin', () => {
    const headers = new Headers({ 'Access-Control-Request-Method': 'POST' })
    expect(isCorsPreflight('OPTIONS', headers)).toBe(false)
  })

  it('is false for non-OPTIONS methods', () => {
    const headers = new Headers({
      Origin: APP,
      'Access-Control-Request-Method': 'POST'
    })
    expect(isCorsPreflight('POST', headers)).toBe(false)
  })
})
