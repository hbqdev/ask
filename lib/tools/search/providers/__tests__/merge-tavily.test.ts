import { describe, expect, it } from 'vitest'

import { mergeTavilyIntoSearxngResults } from '../merge-tavily'

const tav = (url: string, content = 'snippet') => ({ title: 't', url, content })

describe('mergeTavilyIntoSearxngResults', () => {
  it('prepends unique tavily results with their snippet content', () => {
    const merged = mergeTavilyIntoSearxngResults(
      [{ title: 's', url: 'https://a.com', content: 'searxng' }],
      [tav('https://b.com', 'tavily snippet')],
      10
    )
    expect(merged.map(r => r.url).sort()).toEqual([
      'https://a.com',
      'https://b.com'
    ])
    expect(merged.find(r => r.url === 'https://b.com')!.content).toBe(
      'tavily snippet'
    )
  })

  it('dedupes a tavily result that duplicates an existing URL, tavily winning', () => {
    const merged = mergeTavilyIntoSearxngResults(
      [{ title: 's', url: 'https://a.com/', content: 'searxng snippet' }],
      [tav('https://a.com', 'tavily snippet')],
      10
    )
    expect(merged).toHaveLength(1)
    // Tavily is merged first, so it wins the URL collision.
    expect(merged[0].content).toBe('tavily snippet')
  })

  it('caps at maxResults', () => {
    const merged = mergeTavilyIntoSearxngResults(
      [{ title: 's', url: 'https://a.com', content: 'c' }],
      [tav('https://b.com'), tav('https://c.com')],
      2
    )
    expect(merged).toHaveLength(2)
  })

  it('does not starve tavily results when searxng already fills maxResults', () => {
    const merged = mergeTavilyIntoSearxngResults(
      [
        { title: 's1', url: 'https://a.com', content: 'a' },
        { title: 's2', url: 'https://b.com', content: 'b' },
        { title: 's3', url: 'https://c.com', content: 'c' }
      ],
      [tav('https://d.com', 'tavily content')],
      3
    )
    expect(merged).toHaveLength(3)
    // Tavily survives the cap...
    expect(merged.map(r => r.url)).toContain('https://d.com')
    // ...at the expense of the lowest-priority (last) searxng entry.
    expect(merged.map(r => r.url)).not.toContain('https://c.com')
  })

  it('is a no-op passthrough when there are no tavily results', () => {
    const base = [{ title: 's', url: 'https://a.com', content: 'a' }]
    const merged = mergeTavilyIntoSearxngResults(base, [], 10)
    expect(merged.map(r => r.url)).toEqual(['https://a.com'])
  })

  it('drops tavily results with an empty/invalid URL', () => {
    const merged = mergeTavilyIntoSearxngResults(
      [{ title: 's', url: 'https://a.com', content: 'a' }],
      [tav('', 'no url'), tav('https://b.com', 'ok')],
      10
    )
    expect(merged.map(r => r.url).sort()).toEqual([
      'https://a.com',
      'https://b.com'
    ])
  })
})
