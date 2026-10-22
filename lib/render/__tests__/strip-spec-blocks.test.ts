import { describe, expect, test } from 'vitest'

import { stripSpecBlocks } from '../strip-spec-blocks'

describe('stripSpecBlocks', () => {
  test('removes a single spec block', () => {
    const input = [
      '## Heading',
      '',
      '```spec',
      '{"op":"add","path":"/root","value":"x"}',
      '```',
      '',
      'tail'
    ].join('\n')

    const result = stripSpecBlocks(input)
    expect(result).not.toContain('```spec')
    expect(result).toContain('## Heading')
    expect(result).toContain('tail')
  })

  test('removes multiple spec blocks interleaved with markdown', () => {
    const input = [
      '## Section A',
      '',
      '```spec',
      '{"op":"add","path":"/root","value":"imgs1"}',
      '```',
      '',
      'Body paragraph between blocks.',
      '',
      '```spec',
      '{"op":"add","path":"/root","value":"imgs2"}',
      '```',
      '',
      'Closing.',
      '',
      '```spec',
      '{"op":"add","path":"/root","value":"related"}',
      '```'
    ].join('\n')

    const result = stripSpecBlocks(input)
    expect(result).not.toContain('```spec')
    expect(result).not.toContain('imgs1')
    expect(result).not.toContain('imgs2')
    expect(result).not.toContain('related')
    expect(result).toContain('## Section A')
    expect(result).toContain('Body paragraph between blocks.')
    expect(result).toContain('Closing.')
  })

  test('leaves non-spec fenced blocks intact', () => {
    const input = [
      '```ts',
      'const x = 1',
      '```',
      '',
      '```spec',
      '{"op":"add","path":"/root","value":"r"}',
      '```'
    ].join('\n')

    const result = stripSpecBlocks(input)
    expect(result).toContain('```ts')
    expect(result).toContain('const x = 1')
    expect(result).not.toContain('```spec')
  })

  test('keeps a ```spec mentioned mid-line (not a fence)', () => {
    const input = 'Use the ```spec fence for widgets. More text follows.'
    expect(stripSpecBlocks(input)).toBe(input)
  })

  test('a mid-line mention does not swallow a real block after it', () => {
    const input = [
      'Use the ```spec fence for widgets.',
      '',
      '```spec',
      '{"op":"add","path":"/root","value":"r"}',
      '```',
      '',
      'Tail.'
    ].join('\n')
    expect(stripSpecBlocks(input)).toBe(
      'Use the ```spec fence for widgets.\n\nTail.'
    )
  })

  test('still removes an indented spec block (inside a list item)', () => {
    const input = [
      '1. Item',
      '    ```spec',
      '    {"op":"add"}',
      '    ```',
      'Tail.'
    ].join('\n')
    const result = stripSpecBlocks(input)
    expect(result).not.toContain('op')
    expect(result).toContain('1. Item')
    expect(result).toContain('Tail.')
  })
})
