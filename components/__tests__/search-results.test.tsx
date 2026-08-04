import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { SearchResultItem } from '@/lib/types'

import { SearchResults } from '../search-results'

// Search sources (SearXNG, degoog, brave, exa, ollama) return HTML-encoded
// text. The source cards render title/content as React text nodes, which do
// NOT decode entities, so `&#x27;` / `&quot;` showed literally. SearchResults
// decodes at the render layer so every provider and every persisted result is
// covered.
const withEntities: SearchResultItem[] = [
  {
    title: 'Anthropic&#x27;s new model',
    url: 'https://example.com/a',
    content: 'They said &quot;hello&quot; &amp; left'
  }
]

describe('SearchResults entity decoding', () => {
  it('decodes title and content in list mode', () => {
    const { container } = render(
      <SearchResults results={withEntities} displayMode="list" />
    )
    expect(container.textContent).toContain("Anthropic's new model")
    expect(container.textContent).toContain('They said "hello" & left')
    expect(container.textContent).not.toContain('&#x27;')
    expect(container.textContent).not.toContain('&quot;')
    expect(container.textContent).not.toContain('&amp;')
  })

  it('decodes the title in grid mode', () => {
    const { container } = render(
      <SearchResults results={withEntities} displayMode="grid" />
    )
    expect(container.textContent).toContain("Anthropic's new model")
    expect(container.textContent).not.toContain('&#x27;')
  })
})
