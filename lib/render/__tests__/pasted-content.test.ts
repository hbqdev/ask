import { describe, expect, it } from 'vitest'

import { splitPastedContent } from '../pasted-content'

describe('splitPastedContent', () => {
  it('leaves text without pasted blocks as it is, trimmed', () => {
    expect(splitPastedContent('  What is this?  ')).toEqual({
      cards: [],
      rest: 'What is this?'
    })
  })

  it('splits each legacy <user-content> block out of the text', () => {
    const text =
      '<user-content>\nfirst paste\n</user-content>\n\nSummarise both\n\n<user-content>second\npaste</user-content>'
    expect(splitPastedContent(text)).toEqual({
      cards: ['first paste', 'second\npaste'],
      rest: 'Summarise both'
    })
  })

  it('leaves an unclosed tag in the text', () => {
    expect(splitPastedContent('<user-content>\nhalf')).toEqual({
      cards: [],
      rest: '<user-content>\nhalf'
    })
  })

  it('keeps an empty block as an empty card', () => {
    expect(splitPastedContent('Hi <user-content></user-content>')).toEqual({
      cards: [''],
      rest: 'Hi'
    })
  })

  it('splits the same way on every call', () => {
    const text = '<user-content>a</user-content>b'
    expect(splitPastedContent(text)).toEqual(splitPastedContent(text))
  })
})
