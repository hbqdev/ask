import { describe, expect, it } from 'vitest'

import { safeRelativePath } from '../safe-redirect'

describe('safeRelativePath', () => {
  it('passes clean same-origin relative paths through unchanged', () => {
    expect(safeRelativePath('/')).toBe('/')
    expect(safeRelativePath('/search/abc')).toBe('/search/abc')
    expect(safeRelativePath('/a?b=c#d')).toBe('/a?b=c#d')
  })

  it('falls back to / for empty / nullish input', () => {
    expect(safeRelativePath(null)).toBe('/')
    expect(safeRelativePath(undefined)).toBe('/')
    expect(safeRelativePath('')).toBe('/')
  })

  it('rejects absolute and scheme-relative URLs (open redirect)', () => {
    expect(safeRelativePath('https://evil.example')).toBe('/')
    expect(safeRelativePath('http://evil.example/path')).toBe('/')
    expect(safeRelativePath('//evil.example')).toBe('/')
    expect(safeRelativePath('javascript:alert(1)')).toBe('/')
  })

  it('rejects backslash-smuggled and control-char paths', () => {
    expect(safeRelativePath('/\\evil.example')).toBe('/')
    expect(safeRelativePath('/foo\r\nSet-Cookie: x')).toBe('/')
    expect(safeRelativePath('/foo\tbar')).toBe('/')
  })

  it('rejects values without a leading slash', () => {
    expect(safeRelativePath('evil.example')).toBe('/')
    expect(safeRelativePath('foo/bar')).toBe('/')
  })
})
