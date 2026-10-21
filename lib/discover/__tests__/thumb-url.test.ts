import { describe, expect, it } from 'vitest'

import { thumbUrl } from '@/lib/discover/thumb-url'

describe('thumbUrl', () => {
  it('keeps only the id param of a Bing thumbnail', () => {
    expect(
      thumbUrl(
        'https://www.bing.com/th?id=OVFT.abc123&pid=News&w=234&h=132&c=14&rs=2&qlt=90'
      )
    ).toBe('https://www.bing.com/th?id=OVFT.abc123')
  })

  it('returns a Bing URL without an id param as it is', () => {
    const raw = 'https://www.bing.com/th?pid=News&w=234'
    expect(thumbUrl(raw)).toBe(raw)
  })

  it('returns a non-Bing URL as it is', () => {
    const raw = 'https://images.example.com/a.jpg?id=1&w=300'
    expect(thumbUrl(raw)).toBe(raw)
  })

  it('returns invalid input as it is', () => {
    expect(thumbUrl('not a url')).toBe('not a url')
    expect(thumbUrl('')).toBe('')
  })
})
