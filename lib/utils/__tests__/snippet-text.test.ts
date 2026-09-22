import { describe, expect, it } from 'vitest'

import { snippetText } from '../snippet-text'

describe('snippetText', () => {
  it('strips highlight markup from provider snippets', () => {
    expect(snippetText('Node.<strong>js 27,</strong> released')).toBe(
      'Node.js 27, released'
    )
  })

  it('decodes common entities', () => {
    expect(snippetText('Tom &amp; Jerry &quot;hi&quot; it&#39;s &lt;3')).toBe(
      'Tom & Jerry "hi" it\'s <3'
    )
  })

  it('collapses whitespace and handles empty input', () => {
    expect(snippetText('  a \n\n b  ')).toBe('a b')
    expect(snippetText(undefined)).toBe('')
  })

  it('leaves plain text untouched', () => {
    expect(snippetText('2 < 3 and 5 > 4')).toBe('2 < 3 and 5 > 4')
  })
})
