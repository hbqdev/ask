import { describe, expect, it } from 'vitest'

import {
  mergeOllamaIntoResults,
  mergeOllamaIntoSearxngResults
} from '../merge-ollama'

const oll = (url: string, content = 'x') => ({ title: 't', url, content })

describe('mergeOllamaIntoSearxngResults', () => {
  it('appends unique ollama results with FULL content', () => {
    const merged = mergeOllamaIntoSearxngResults(
      [{ title: 's', url: 'https://a.com', content: 'snip' }],
      [oll('https://b.com', 'long full content')],
      10
    )
    expect(merged.map(r => r.url).sort()).toEqual([
      'https://a.com',
      'https://b.com'
    ])
    expect(merged.find(r => r.url === 'https://b.com')!.content).toBe(
      'long full content'
    )
  })

  it('dedupes an ollama result that duplicates an existing URL', () => {
    const merged = mergeOllamaIntoSearxngResults(
      [{ title: 's', url: 'https://a.com/', content: 'snip' }],
      [oll('https://a.com')],
      10
    )
    expect(merged).toHaveLength(1)
  })

  it('caps at maxResults', () => {
    const merged = mergeOllamaIntoSearxngResults(
      [{ title: 's', url: 'https://a.com', content: 'c' }],
      [oll('https://b.com'), oll('https://c.com')],
      2
    )
    expect(merged).toHaveLength(2)
  })
})

describe('mergeOllamaIntoResults', () => {
  it('truncates ollama content to maxContentChars', () => {
    const merged = mergeOllamaIntoResults(
      [],
      [oll('https://b.com', 'abcdefghij')],
      10,
      4
    )
    expect(merged[0].content).toBe('abcd…')
  })

  it('keeps short content untouched and dedupes by URL', () => {
    const merged = mergeOllamaIntoResults(
      [{ title: 's', url: 'https://a.com', content: 'snip' }],
      [oll('https://a.com', 'dup'), oll('https://b.com', 'ok')],
      10,
      100
    )
    expect(merged.map(r => r.url)).toEqual(['https://a.com', 'https://b.com'])
    expect(merged[1].content).toBe('ok')
  })
})
