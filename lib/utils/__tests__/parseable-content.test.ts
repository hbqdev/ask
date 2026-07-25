import { describe, expect, it } from 'vitest'

import {
  isParseableContentType,
  MAX_PARSEABLE_BYTES
} from '../parseable-content'

describe('isParseableContentType', () => {
  it('accepts html', () => {
    expect(isParseableContentType('text/html')).toBe(true)
    expect(isParseableContentType('text/html; charset=utf-8')).toBe(true)
    expect(isParseableContentType('application/xhtml+xml')).toBe(true)
  })

  it('accepts plain text', () => {
    expect(isParseableContentType('text/plain')).toBe(true)
  })

  it('assumes html when the server sends no content-type', () => {
    // Plenty of pages omit it; refusing them would lose real sources.
    expect(isParseableContentType(undefined)).toBe(true)
    expect(isParseableContentType('')).toBe(true)
  })

  it('rejects pdf, the case that actually costs us', () => {
    expect(isParseableContentType('application/pdf')).toBe(false)
  })

  it('rejects binary payloads that would be parsed as garbage', () => {
    expect(isParseableContentType('image/png')).toBe(false)
    expect(isParseableContentType('video/mp4')).toBe(false)
    expect(isParseableContentType('application/octet-stream')).toBe(false)
    expect(isParseableContentType('application/zip')).toBe(false)
  })

  it('is case- and whitespace-insensitive', () => {
    expect(isParseableContentType('  TEXT/HTML  ')).toBe(true)
    expect(isParseableContentType('APPLICATION/PDF')).toBe(false)
  })

  it('caps parseable size well above a real article', () => {
    expect(MAX_PARSEABLE_BYTES).toBeGreaterThan(1_000_000)
    expect(MAX_PARSEABLE_BYTES).toBeLessThanOrEqual(10_000_000)
  })
})
