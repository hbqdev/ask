import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'

import { describe, expect, it } from 'vitest'

import { config } from '@/proxy'

const matches = (url: string) =>
  unstable_doesMiddlewareMatch({ config, url: `https://ask.test${url}` })

// The proxy wraps a matched request body in a 10 MB clone
// (experimental.proxyClientMaxBodySize) and silently ends it there, so the
// two raw-upload routes must never be matched: they answer CORS themselves.
describe('proxy matcher', () => {
  it('does not run the proxy for the upload and transcribe routes', () => {
    expect(matches('/api/upload')).toBe(false)
    expect(matches('/api/voice/transcribe')).toBe(false)
  })

  // The ingest worker posts every extracted chunk of a file at once; a large
  // text file makes a body well past 10 MB. The route checks the worker's
  // bearer token itself and needs no session or CORS from the proxy.
  it('does not run the proxy for the ingest completion route', () => {
    expect(matches('/api/ingest/complete')).toBe(false)
    expect(matches('/api/ingest/claim')).toBe(true)
    expect(matches('/api/ingest/complete-x')).toBe(true)
  })

  it('still runs the proxy for the other API routes and pages', () => {
    expect(matches('/api/chat')).toBe(true)
    expect(matches('/api/voice/speak')).toBe(true)
    expect(matches('/api/files/status')).toBe(true)
    expect(matches('/search/abc')).toBe(true)
    expect(matches('/')).toBe(true)
  })

  it('excludes only those exact paths, not look-alike prefixes', () => {
    expect(matches('/api/uploads')).toBe(true)
    expect(matches('/api/voice/transcribe-x')).toBe(true)
  })

  it('keeps skipping static assets', () => {
    expect(matches('/logo.png')).toBe(false)
    expect(matches('/_next/static/chunk.js')).toBe(false)
  })
})
