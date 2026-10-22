import { describe, expect, it } from 'vitest'

import { NOTE_PREVIEW_MAX, notePreview } from '@/features/notes/note-preview'

describe('notePreview', () => {
  it('is the content as one line of plain text', () => {
    expect(notePreview('## Tides\n\nThe **moon** pulls the _sea_.\n')).toBe(
      'Tides The moon pulls the sea.'
    )
  })

  it('keeps a link’s text and drops its URL', () => {
    expect(
      notePreview('See [NOAA](https://noaa.gov/tides) and [1](https://x.test).')
    ).toBe('See NOAA and 1.')
  })

  it('drops list, quote and code markers', () => {
    expect(notePreview('> quoted\n- one\n* two\n1. three\n`code`')).toBe(
      'quoted one two three code'
    )
  })

  it('drops code fences', () => {
    expect(notePreview('```ts\nconst a = 1\n```')).toBe('const a = 1')
  })

  it('is cut to the maximum length', () => {
    const preview = notePreview('word '.repeat(200))
    expect(preview.length).toBeLessThanOrEqual(NOTE_PREVIEW_MAX)
  })

  it('is empty for empty content', () => {
    expect(notePreview('  \n ')).toBe('')
  })
})
