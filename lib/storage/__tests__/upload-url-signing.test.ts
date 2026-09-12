import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  isUploadSigningConfigured,
  signUploadUrl,
  signUploadUrlsInMessages,
  uploadSignatureRequired,
  uploadUrlTtlSeconds,
  verifyUploadSignature
} from '../upload-url-signing'

const SECRET = 'test-secret-value'

// Pull the exp/sig a signer produced back out of a signed URL so a test can
// verify them exactly as the route would.
function partsOf(signedUrl: string): { exp: string; sig: string } {
  const u = new URL(signedUrl, 'http://uploads.local')
  return {
    exp: u.searchParams.get('exp') ?? '',
    sig: u.searchParams.get('sig') ?? ''
  }
}

function objectKeyOf(url: string): string {
  return new URL(url, 'http://uploads.local').pathname.slice('/uploads/'.length)
}

describe('upload-url-signing (unconfigured)', () => {
  beforeEach(() => {
    delete process.env.UPLOADS_URL_SECRET
    delete process.env.UPLOADS_REQUIRE_SIGNATURE
    delete process.env.UPLOADS_URL_TTL_S
  })

  it('reports not configured and leaves URLs untouched', () => {
    expect(isUploadSigningConfigured()).toBe(false)
    const url = '/uploads/u1/chats/c1/pic.png'
    expect(signUploadUrl(url)).toBe(url)
  })

  it('signUploadUrlsInMessages is a no-op without a secret', () => {
    const messages = [
      { parts: [{ type: 'file', url: '/uploads/u1/chats/c1/pic.png' }] }
    ]
    expect(signUploadUrlsInMessages(messages)).toBe(messages)
  })
})

describe('upload-url-signing (configured)', () => {
  beforeEach(() => {
    process.env.UPLOADS_URL_SECRET = SECRET
    delete process.env.UPLOADS_REQUIRE_SIGNATURE
    delete process.env.UPLOADS_URL_TTL_S
  })

  afterEach(() => {
    delete process.env.UPLOADS_URL_SECRET
    delete process.env.UPLOADS_REQUIRE_SIGNATURE
    delete process.env.UPLOADS_URL_TTL_S
  })

  it('signs + verifies a root-relative URL (roundtrip ok)', () => {
    const url = '/uploads/u1/chats/c1/pic.png'
    const signed = signUploadUrl(url)
    expect(signed).not.toBe(url)
    expect(signed.startsWith('/uploads/u1/chats/c1/pic.png?')).toBe(true)

    const { exp, sig } = partsOf(signed)
    expect(verifyUploadSignature('u1/chats/c1/pic.png', exp, sig)).toBe('ok')
  })

  it('signs an absolute URL and keeps the host', () => {
    const url = 'https://ask.hbqnexus.win/uploads/u1/generated/c1/img.webp'
    const signed = signUploadUrl(url)
    const u = new URL(signed)
    expect(u.host).toBe('ask.hbqnexus.win')
    expect(u.pathname).toBe('/uploads/u1/generated/c1/img.webp')
    const { exp, sig } = partsOf(signed)
    expect(verifyUploadSignature('u1/generated/c1/img.webp', exp, sig)).toBe(
      'ok'
    )
  })

  it('rejects a tampered signature as bad', () => {
    const signed = signUploadUrl('/uploads/u1/chats/c1/pic.png')
    const { exp, sig } = partsOf(signed)
    const tampered = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a')
    expect(verifyUploadSignature('u1/chats/c1/pic.png', exp, tampered)).toBe(
      'bad'
    )
  })

  it('rejects a valid signature reused for a DIFFERENT path as bad', () => {
    const signed = signUploadUrl('/uploads/u1/chats/c1/pic.png')
    const { exp, sig } = partsOf(signed)
    // Same exp+sig, different object key (an attacker swapping the path).
    expect(verifyUploadSignature('u1/chats/c1/other.png', exp, sig)).toBe('bad')
    // Cross-user swap (the userId segment is part of the signed key).
    expect(verifyUploadSignature('victim/chats/c1/pic.png', exp, sig)).toBe(
      'bad'
    )
  })

  it('treats a past-deadline but validly-signed URL as expired (410, not 403)', () => {
    // Negative TTL → exp in the past, still correctly signed for that exp.
    const signed = signUploadUrl('/uploads/u1/chats/c1/pic.png', -100)
    const { exp, sig } = partsOf(signed)
    expect(verifyUploadSignature('u1/chats/c1/pic.png', exp, sig)).toBe(
      'expired'
    )
  })

  it('treats a missing signature or expiry as bad', () => {
    expect(verifyUploadSignature('u1/chats/c1/pic.png', null, null)).toBe('bad')
    expect(verifyUploadSignature('u1/chats/c1/pic.png', '123', null)).toBe(
      'bad'
    )
    expect(verifyUploadSignature('u1/chats/c1/pic.png', null, 'deadbeef')).toBe(
      'bad'
    )
    expect(
      verifyUploadSignature('u1/chats/c1/pic.png', 'not-a-number', 'deadbeef')
    ).toBe('bad')
  })

  it('re-signs idempotently: a stale exp/sig is stripped, not duplicated', () => {
    const first = signUploadUrl('/uploads/u1/chats/c1/pic.png', -100) // expired
    const second = signUploadUrl(first) // re-sign the already-signed URL
    const u = new URL(second, 'http://uploads.local')
    expect(u.searchParams.getAll('exp')).toHaveLength(1)
    expect(u.searchParams.getAll('sig')).toHaveLength(1)
    const { exp, sig } = partsOf(second)
    expect(verifyUploadSignature('u1/chats/c1/pic.png', exp, sig)).toBe('ok')
  })

  it('preserves a #fragment (citation chunk anchors)', () => {
    const signed = signUploadUrl('/uploads/u1/chats/c1/notes.txt#chunk-2')
    expect(signed).toContain('#chunk-2')
    const u = new URL(signed, 'http://uploads.local')
    expect(u.hash).toBe('#chunk-2')
    const { exp, sig } = partsOf(signed)
    expect(verifyUploadSignature(objectKeyOf(signed), exp, sig)).toBe('ok')
  })

  it('leaves a non-uploads URL unchanged', () => {
    const url = 'https://example.com/some/file.png'
    expect(signUploadUrl(url)).toBe(url)
  })

  it('honors UPLOADS_URL_TTL_S', () => {
    process.env.UPLOADS_URL_TTL_S = '120'
    expect(uploadUrlTtlSeconds()).toBe(120)
    const before = Math.floor(Date.now() / 1000)
    const { exp } = partsOf(signUploadUrl('/uploads/u1/chats/c1/pic.png'))
    expect(Number(exp) - before).toBeGreaterThanOrEqual(115)
    expect(Number(exp) - before).toBeLessThanOrEqual(125)
  })

  it('uploadSignatureRequired reflects the flag', () => {
    expect(uploadSignatureRequired()).toBe(false)
    process.env.UPLOADS_REQUIRE_SIGNATURE = 'true'
    expect(uploadSignatureRequired()).toBe(true)
  })
})

describe('signUploadUrlsInMessages (render-time re-signing)', () => {
  beforeEach(() => {
    process.env.UPLOADS_URL_SECRET = SECRET
  })
  afterEach(() => {
    delete process.env.UPLOADS_URL_SECRET
  })

  it('signs file parts, generateImage output, and documentRetrieval results', () => {
    const messages = [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'hi' },
          { type: 'file', url: '/uploads/u1/chats/c1/pic.png' }
        ]
      },
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool-generateImage',
            output: {
              imageUrl: '/uploads/u1/generated/c1/1-a.png',
              prompt: 'a fox'
            }
          },
          {
            type: 'tool-documentRetrieval',
            output: {
              state: 'complete',
              results: [
                {
                  title: 'notes',
                  url: 'https://ask.local/uploads/u1/chats/c1/notes.txt#chunk-1',
                  content: 'x'
                }
              ]
            }
          }
        ]
      }
    ]

    const out = signUploadUrlsInMessages(messages as any) as any[]

    const filePart = out[0].parts[1]
    expect(filePart.url).toContain('sig=')
    expect(
      verifyUploadSignature('u1/chats/c1/pic.png', ...splat(filePart.url))
    ).toBe('ok')

    const imgPart = out[1].parts[0]
    expect(imgPart.output.imageUrl).toContain('sig=')
    expect(imgPart.output.prompt).toBe('a fox')
    expect(
      verifyUploadSignature(
        'u1/generated/c1/1-a.png',
        ...splat(imgPart.output.imageUrl)
      )
    ).toBe('ok')

    const cite = out[1].parts[1].output.results[0]
    expect(cite.url).toContain('sig=')
    expect(cite.url).toContain('#chunk-1')
    expect(
      verifyUploadSignature('u1/chats/c1/notes.txt', ...splat(cite.url))
    ).toBe('ok')

    // Original messages are not mutated in place.
    expect((messages[0].parts[1] as any).url).toBe(
      '/uploads/u1/chats/c1/pic.png'
    )
  })

  it('leaves parts with no uploads URL untouched', () => {
    const messages = [
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'answer' },
          {
            type: 'tool-search',
            output: {
              results: [{ title: 't', url: 'https://ex.com', content: 'c' }]
            }
          }
        ]
      }
    ]
    const out = signUploadUrlsInMessages(messages as any) as any[]
    expect(out[0].parts[1].output.results[0].url).toBe('https://ex.com')
  })
})

function splat(signedUrl: string): [string, string] {
  const u = new URL(signedUrl, 'http://uploads.local')
  return [u.searchParams.get('exp') ?? '', u.searchParams.get('sig') ?? '']
}
