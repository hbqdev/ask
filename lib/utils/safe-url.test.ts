import { describe, expect, test } from 'vitest'

import { safeUrlParts, sanitizeHttpUrl } from './safe-url'

describe('sanitizeHttpUrl', () => {
  test('passes through http(s) URLs', () => {
    expect(sanitizeHttpUrl('https://example.com/path')).toBe(
      'https://example.com/path'
    )
    expect(sanitizeHttpUrl('http://example.com')).toBe('http://example.com/')
  })

  test('blocks dangerous schemes a search/news engine could return', () => {
    // These are the render-layer XSS vectors this helper exists to stop.
    expect(sanitizeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(
      sanitizeHttpUrl('data:text/html,<script>alert(1)</script>')
    ).toBeNull()
    expect(sanitizeHttpUrl('vbscript:msgbox(1)')).toBeNull()
    expect(sanitizeHttpUrl('  JavaScript:alert(1)')).toBeNull()
  })

  test('returns null for missing or malformed input', () => {
    expect(sanitizeHttpUrl(undefined)).toBeNull()
    expect(sanitizeHttpUrl(null)).toBeNull()
    expect(sanitizeHttpUrl('')).toBeNull()
    expect(sanitizeHttpUrl('not a url')).toBeNull()
  })
})

describe('safeUrlParts', () => {
  test('extracts hostname and pathname from a valid URL', () => {
    expect(safeUrlParts('https://example.com/a/b')).toEqual({
      hostname: 'example.com',
      pathname: '/a/b'
    })
  })

  test('returns empty strings instead of throwing on a malformed URL', () => {
    // A poisoned result must not crash the render.
    expect(safeUrlParts('not a url')).toEqual({ hostname: '', pathname: '' })
    expect(safeUrlParts(undefined)).toEqual({ hostname: '', pathname: '' })
  })
})
