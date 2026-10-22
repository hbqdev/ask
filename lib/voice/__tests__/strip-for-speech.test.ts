// lib/voice/__tests__/strip-for-speech.test.ts
import { describe, expect, it } from 'vitest'

import { firstSentences, stripForSpeech } from '../strip-for-speech'

describe('stripForSpeech', () => {
  it('removes [n](#id) citation anchors but keeps the sentence', () => {
    expect(stripForSpeech('Nvidia leads the market [1](#call_abc).')).toBe(
      'Nvidia leads the market.'
    )
  })

  it('drops markdown tables entirely', () => {
    const md =
      'Here is a comparison:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nDone.'
    expect(stripForSpeech(md)).toBe('Here is a comparison: Done.')
  })

  it('strips bare URLs and markdown link syntax', () => {
    expect(
      stripForSpeech('See [the docs](https://x.com/y) at https://z.io.')
    ).toBe('See the docs at.')
  })

  it('removes heading/bold/list markup and collapses whitespace', () => {
    expect(stripForSpeech('## Title\n\n- **Key** point\n- Another')).toBe(
      'Title Key point Another'
    )
  })

  it('drops a terminated ```spec related-questions block, keeping the prose', () => {
    const md =
      'The engine keeps its character.\n\n```spec\n' +
      '{"op":"add","path":"/root","value":"main"}\n' +
      '{"op":"add","path":"/elements/main","value":{"type":"Stack"}}\n' +
      '```\n\nThat is all.'
    const out = stripForSpeech(md)
    expect(out).toBe('The engine keeps its character. That is all.')
    expect(out).not.toMatch(/spec|"op"|\/root/)
  })

  it('drops an unterminated trailing ```spec block (stream cut, no closing fence)', () => {
    const md =
      'The engine keeps its character.\n\n```spec\n' +
      '{"op":"add","path":"/root","value":"main"}\n' +
      '{"op":"add","path":"/elements/main"'
    expect(stripForSpeech(md)).toBe('The engine keeps its character.')
  })

  it('removes horizontal-rule lines (---, ***, ___) between paragraphs', () => {
    const md =
      'First part.\n\n---\n\nSecond part.\n\n***\n\nThird.\n\n___\n\nEnd.'
    expect(stripForSpeech(md)).toBe('First part. Second part. Third. End.')
  })

  it('drops fenced code blocks entirely, not just their backticks', () => {
    const md =
      'Run this:\n\n```python\ndef scatter(w):\n    return 1 / w ** 4\n```\n\n' +
      'Then use `scatter()` to compare.'
    const out = stripForSpeech(md)
    expect(out).toBe('Run this: Then use scatter() to compare.')
    expect(out).not.toMatch(/python|def |return/)
  })

  it('drops an unclosed code fence to the end (stream cut)', () => {
    expect(stripForSpeech('Run this:\n\n```bash\nrm -rf build')).toBe(
      'Run this:'
    )
  })

  it('drops a code block and a ```spec block in the same answer', () => {
    const md =
      'Example:\n\n```js\nconst a = 1\n```\n\nDone.\n\n```spec\n' +
      '{"op":"add","path":"/root","value":"main"}\n```'
    expect(stripForSpeech(md)).toBe('Example: Done.')
  })

  it('removes the comma left before a sentence end by a dropped citation', () => {
    expect(
      stripForSpeech('Blue scatters most [2](#call_a), [3](#call_b).')
    ).toBe('Blue scatters most.')
    expect(stripForSpeech('It varies [1](#call_a);  [2](#call_b)!')).toBe(
      'It varies!'
    )
  })

  it('keeps prose that mentions ``` mid-line (not a fence)', () => {
    expect(
      stripForSpeech(
        'Markdown fences start with ``` and a language. Then you write code.'
      )
    ).toBe('Markdown fences start with and a language. Then you write code.')
    expect(
      stripForSpeech('Use `` ``` `` to open a fence. More prose follows here.')
    ).toBe('Use to open a fence. More prose follows here.')
  })

  it('drops a fence that opens on the last line with nothing after it', () => {
    expect(stripForSpeech('Here it comes:\n\n```bash')).toBe('Here it comes:')
  })

  it('drops an indented fence (up to three spaces) and its closing line', () => {
    expect(stripForSpeech('Steps:\n\n   ```sh\n   make\n   ```\n\nDone.')).toBe(
      'Steps: Done.'
    )
  })

  it('keeps prose that mentions ```spec mid-line', () => {
    expect(
      stripForSpeech('Use the ```spec fence to add widgets. Then more prose.')
    ).toBe('Use the spec fence to add widgets. Then more prose.')
  })

  it('still drops an unterminated ```spec block at a line start', () => {
    expect(stripForSpeech('Answer.\n\n  ```spec\n{"op":"add"')).toBe('Answer.')
  })

  it('drops a fence indented inside a list item (four or more spaces)', () => {
    expect(
      stripForSpeech(
        '1. Run this:\n\n    ```bash\n    npm install\n    ```\n\n2. Done.'
      )
    ).toBe('1. Run this: 2. Done.')
  })

  it('closes a four-backtick fence only with four or more backticks', () => {
    expect(
      stripForSpeech(
        'Example:\n\n````md\n```js\nx\n```\n````\n\nAfter the example.'
      )
    ).toBe('Example: After the example.')
    expect(
      stripForSpeech('Example:\n\n````md\ninner\n`````\n\nAfter it.')
    ).toBe('Example: After it.')
  })

  it('reads a line-start ```inline code``` span as prose, not a fence', () => {
    expect(stripForSpeech('```npm i``` installs it. More words.')).toBe(
      'npm i installs it. More words.'
    )
  })

  it('keeps commas and colons that belong to the prose', () => {
    expect(stripForSpeech('Yes, it works: 3:1 ratio, as expected.')).toBe(
      'Yes, it works: 3:1 ratio, as expected.'
    )
  })
})

describe('firstSentences', () => {
  it('returns the first n sentences', () => {
    expect(firstSentences('One. Two. Three.', 2)).toBe('One. Two.')
  })
  it('returns everything if fewer than n', () => {
    expect(firstSentences('Only one.', 2)).toBe('Only one.')
  })
})

describe('firstSentences — decimals and sentence starts', () => {
  it('does not split on a decimal point and starts at the true beginning', () => {
    const text =
      'Short answer: the 4090 is about 1.6–2× faster at token generation. Both have 24 GB.'
    expect(firstSentences(text, 1)).toBe(
      'Short answer: the 4090 is about 1.6–2× faster at token generation.'
    )
    expect(firstSentences(text, 2)).toBe(text)
  })

  it('keeps a decimal temperature inside its sentence', () => {
    const text =
      'A fever of 39°C (102.2°F) in a child is common. Most fevers pass in a few days. See a doctor if it persists.'
    expect(firstSentences(text, 2)).toBe(
      'A fever of 39°C (102.2°F) in a child is common. Most fevers pass in a few days.'
    )
  })

  it('splits on ! and ?', () => {
    expect(firstSentences('Wow! Really? Yes. No.', 3)).toBe('Wow! Really? Yes.')
  })

  it('returns trimmed text when there is no terminal punctuation', () => {
    expect(firstSentences('  no punctuation here  ', 2)).toBe(
      'no punctuation here'
    )
  })
})
