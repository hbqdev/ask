import React from 'react'

import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ToolPart } from '@/lib/types/ai'

import { SearchSection } from '../search-section'

// The turn's first search also runs up to 3 expansion variants and merges
// their results; `expandedQueries` on its output lists them. The card shows
// them as a `+N` after the query and an "Also searched" list above Sources.
// Only the artifact inspector context is stubbed (its provider needs the
// sidebar + library providers).
vi.mock('@/components/artifact/artifact-context', () => ({
  useArtifact: () => ({ open: vi.fn() })
}))

const VARIANTS = ['rtx 5090 msrp usd', 'nvidia 5090 launch price']

const searchPart = (extra: Record<string, unknown> = {}) =>
  ({
    type: 'tool-search',
    toolCallId: 'call-search-1',
    state: 'output-available',
    input: { query: 'rtx 5090 price' },
    output: {
      state: 'complete',
      query: 'rtx 5090 price',
      images: [],
      results: [
        { title: 'Result A', url: 'https://example.com/a', content: 'a' }
      ],
      number_of_results: 1,
      ...extra
    }
  }) as unknown as ToolPart<'search'>

const renderCard = (tool: ToolPart<'search'>, isOpen = true) =>
  render(<SearchSection tool={tool} isOpen={isOpen} onOpenChange={() => {}} />)

describe('SearchSection: expansion variants', () => {
  it('shows +N after the query, labelled and titled with the variants', () => {
    renderCard(searchPart({ expandedQueries: VARIANTS }), false)

    const badge = screen.getByText('+2').parentElement!
    // One variant per line in the native tooltip.
    expect(badge).toHaveAttribute(
      'title',
      `Also searched:\n${VARIANTS.join('\n')}`
    )
    // The header button's accessible name says what +2 means, set off from
    // the query by a comma so it never runs into it.
    expect(
      screen.getByRole('button', {
        name: /rtx 5090 price\s?, also searched 2 more queries/
      })
    ).toBeInTheDocument()
    // The +N must survive the query's truncation: it sits OUTSIDE the
    // truncating span and does not shrink.
    const querySpan = screen.getByText('rtx 5090 price')
    expect(querySpan).toHaveClass('truncate')
    expect(querySpan.contains(badge)).toBe(false)
    expect(querySpan.parentElement).toBe(badge.parentElement)
    expect(badge).toHaveClass('shrink-0')
  })

  it('says "query" for a single variant', () => {
    renderCard(searchPart({ expandedQueries: ['only one'] }), false)
    expect(screen.getByText(', also searched 1 more query')).toBeInTheDocument()
  })

  it('lists each variant under "Also searched", above Sources', () => {
    const { container } = renderCard(searchPart({ expandedQueries: VARIANTS }))

    const label = screen.getByText('Also searched')
    const section = label.closest('section')!
    const items = within(section).getAllByRole('listitem')
    expect(items.map(li => li.textContent)).toEqual(VARIANTS)
    // Wraps even a long unbroken token, inside a body that can shrink.
    for (const v of VARIANTS) {
      expect(within(section).getByText(v)).toHaveClass(
        '[overflow-wrap:anywhere]'
      )
    }
    expect(section.parentElement).toHaveClass('flex-1', 'min-w-0')

    const sections = [...container.querySelectorAll('section')]
    const sourcesIndex = sections.findIndex(s =>
      s.textContent?.includes('Sources')
    )
    expect(sourcesIndex).toBeGreaterThan(sections.indexOf(section))
  })

  it('labels "Also searched" with the same small badge as Sources, not a heading', () => {
    renderCard(searchPart({ expandedQueries: VARIANTS }))
    const label = screen.getByText('Also searched')
    const sources = screen.getByText('Sources')
    expect(label.tagName).toBe(sources.tagName)
    expect(label.className).toBe(sources.className)
    expect(
      screen.queryByRole('heading', { name: 'Also searched' })
    ).not.toBeInTheDocument()
    // No icon in the label: the variant rows carry the search icons.
    expect(label.querySelector('svg')).toBeNull()
  })

  it('shows neither on a streamed preview chunk', () => {
    const preview = searchPart({ preview: true })
    renderCard(preview)
    expect(screen.queryByText('Also searched')).not.toBeInTheDocument()
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument()
    // The preview's sources still render.
    expect(screen.getByText('Result A')).toBeInTheDocument()
  })

  it.each([
    ['absent', {}],
    ['empty', { expandedQueries: [] }]
  ])('renders neither when expandedQueries is %s', (_label, extra) => {
    renderCard(searchPart(extra))
    expect(screen.queryByText('Also searched')).not.toBeInTheDocument()
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/also searched/)).not.toBeInTheDocument()
    // The rest of the card is unchanged.
    expect(screen.getByText('Sources')).toBeInTheDocument()
    expect(screen.getByText('rtx 5090 price')).toBeInTheDocument()
  })
})
