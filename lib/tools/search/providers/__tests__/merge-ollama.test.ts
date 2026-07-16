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

  it('does not starve ollama results when searxng already fills maxResults', () => {
    const merged = mergeOllamaIntoSearxngResults(
      [
        { title: 's1', url: 'https://a.com', content: 'a' },
        { title: 's2', url: 'https://b.com', content: 'b' },
        { title: 's3', url: 'https://c.com', content: 'c' }
      ],
      [oll('https://d.com', 'full ollama content')],
      3
    )
    expect(merged).toHaveLength(3)
    expect(merged.map(r => r.url)).toContain('https://d.com')
    // One searxng result is dropped to make room, not the ollama one.
    expect(merged.map(r => r.url)).not.toContain('https://c.com')
  })

  it('keeps ollama content on a URL collision with searxng', () => {
    const merged = mergeOllamaIntoSearxngResults(
      [{ title: 's', url: 'https://a.com', content: 'snip' }],
      [oll('https://a.com', 'full ollama')],
      10
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].content).toBe('full ollama')
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

  it('keeps short content untouched and dedupes by URL, ollama winning the collision', () => {
    const merged = mergeOllamaIntoResults(
      [{ title: 's', url: 'https://a.com', content: 'snip' }],
      [oll('https://a.com', 'dup'), oll('https://b.com', 'ok')],
      10,
      100
    )
    expect(merged.map(r => r.url)).toEqual(['https://a.com', 'https://b.com'])
    // Ollama is merged first, so on a URL collision its content wins over
    // the existing item's snippet.
    expect(merged[0].content).toBe('dup')
    expect(merged[1].content).toBe('ok')
  })

  it('does not starve ollama results when items already fill maxResults', () => {
    const merged = mergeOllamaIntoResults(
      [
        { title: 's1', url: 'https://a.com', content: 'a' },
        { title: 's2', url: 'https://b.com', content: 'b' },
        { title: 's3', url: 'https://c.com', content: 'c' }
      ],
      [oll('https://d.com', 'ollama content')],
      3,
      100
    )
    expect(merged).toHaveLength(3)
    // Ollama survives truncation to maxResults...
    expect(merged.map(r => r.url)).toContain('https://d.com')
    // ...at the expense of the lowest-priority (last) items entry.
    expect(merged.map(r => r.url)).not.toContain('https://c.com')
  })
})
