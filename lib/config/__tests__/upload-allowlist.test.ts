import { describe, expect, it } from 'vitest'

import {
  ACCEPT_ATTRIBUTE,
  ALLOWED_EXTENSIONS,
  isAllowedUpload
} from '../upload-allowlist'

describe('isAllowedUpload', () => {
  it('accepts .htm (regression: was missing from the extension allowlist)', () => {
    expect(ALLOWED_EXTENSIONS.has('htm')).toBe(true)
    expect(isAllowedUpload('text/html', 'page.htm')).toBe(true)
  })

  it('accepts allowed media-family + extension combos', () => {
    expect(isAllowedUpload('image/png', 'photo.png')).toBe(true)
    expect(isAllowedUpload('text/plain', 'notes.txt')).toBe(true)
    expect(isAllowedUpload('audio/mpeg', 'song.mp3')).toBe(true)
  })

  it('accepts code files sent as octet-stream when the extension is allowed', () => {
    expect(isAllowedUpload('application/octet-stream', 'main.py')).toBe(true)
    expect(isAllowedUpload('application/octet-stream', 'app.tsx')).toBe(true)
  })

  it('accepts exact office / document types', () => {
    expect(isAllowedUpload('application/pdf', 'doc.pdf')).toBe(true)
    expect(
      isAllowedUpload(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'report.docx'
      )
    ).toBe(true)
  })

  it('rejects a disallowed extension even with an allowed media type', () => {
    expect(isAllowedUpload('text/plain', 'archive.zip')).toBe(false)
    expect(isAllowedUpload('application/octet-stream', 'a.exe')).toBe(false)
  })

  it('rejects an allowed extension paired with a disallowed media type', () => {
    // ext htm is allowed, but application/zip is neither an exact type nor an
    // allowed family prefix.
    expect(isAllowedUpload('application/zip', 'page.htm')).toBe(false)
  })

  it('rejects a file with no extension', () => {
    expect(isAllowedUpload('text/plain', 'README')).toBe(false)
  })
})

describe('ACCEPT_ATTRIBUTE', () => {
  it('is derived from the extension allowlist and includes .htm', () => {
    const exts = ACCEPT_ATTRIBUTE.split(',')
    expect(exts).toContain('.htm')
    expect(exts).toContain('.html')
    expect(exts).toContain('.pdf')
    // Every entry is a dotted extension present in the allowlist.
    for (const entry of exts) {
      expect(entry.startsWith('.')).toBe(true)
      expect(ALLOWED_EXTENSIONS.has(entry.slice(1))).toBe(true)
    }
  })
})
