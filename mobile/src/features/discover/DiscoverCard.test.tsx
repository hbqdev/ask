import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { DiscoverItem } from '@/features/discover/discover-api'
import { DiscoverLeadCard, DiscoverRow } from '@/features/discover/DiscoverCard'

const ITEM: DiscoverItem = {
  title: 'Chips get faster',
  summary: 'A new process node arrives.',
  url: 'https://news.example.test/chips',
  thumbnail: 'https://img.example.test/chips.jpg'
}

const handlers = () => ({ onOpen: vi.fn(), onSummarize: vi.fn() })

/** The card's image, which is decorative (the title says what it shows). */
const image = (container: HTMLElement) => container.querySelector('img')

describe.each([
  ['DiscoverLeadCard', DiscoverLeadCard],
  ['DiscoverRow', DiscoverRow]
])('%s', (_, Card) => {
  it('opens the article on a tap', () => {
    const h = handlers()
    render(<Card item={ITEM} {...h} />)
    fireEvent.click(screen.getByRole('button', { name: 'Chips get faster' }))
    expect(h.onOpen).toHaveBeenCalledExactlyOnceWith(ITEM.url)
    expect(h.onSummarize).not.toHaveBeenCalled()
  })

  it('summarizes from its own button', () => {
    const h = handlers()
    render(<Card item={ITEM} {...h} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Summarize Chips get faster' })
    )
    expect(h.onSummarize).toHaveBeenCalledExactlyOnceWith(ITEM.url)
    expect(h.onOpen).not.toHaveBeenCalled()
  })

  it('loads its thumbnail lazily, off the main thread, in a fixed box', () => {
    const { container } = render(<Card item={ITEM} {...handlers()} />)
    const img = image(container)!
    expect(img).toHaveAttribute('src', ITEM.thumbnail)
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(img).toHaveAttribute('decoding', 'async')
    expect(img).toHaveAttribute('alt', '')
    expect(screen.getByTestId('discover-thumb')).toContainElement(img)
  })

  it('shows a neutral placeholder, not a broken image, when it fails', () => {
    const { container, rerender } = render(<Card item={ITEM} {...handlers()} />)
    fireEvent.error(image(container)!)
    expect(image(container)).toBeNull()
    expect(screen.getByTestId('discover-thumb')).toContainElement(
      screen.getByTestId('discover-thumb-placeholder')
    )

    // Another thumbnail is tried afresh.
    const next = { ...ITEM, thumbnail: 'https://img.example.test/other.jpg' }
    rerender(<Card item={next} {...handlers()} />)
    expect(image(container)).toHaveAttribute('src', next.thumbnail)
    expect(screen.queryByTestId('discover-thumb-placeholder')).toBeNull()
  })
})

describe('DiscoverLeadCard', () => {
  it('shows a 16:9 image, the title and the summary', () => {
    render(<DiscoverLeadCard item={ITEM} {...handlers()} />)
    expect(screen.getByTestId('discover-thumb')).toHaveClass('aspect-video')
    expect(
      screen.getByRole('heading', { name: 'Chips get faster' })
    ).toBeInTheDocument()
    const card = screen.getByRole('button', { name: 'Chips get faster' })
    expect(card).toHaveAccessibleDescription('A new process node arrives.')
  })
})

describe('DiscoverRow', () => {
  it('shows a thumbnail and the title, without the summary', () => {
    render(<DiscoverRow item={ITEM} {...handlers()} />)
    expect(screen.getByText('Chips get faster')).toBeInTheDocument()
    expect(screen.queryByText('A new process node arrives.')).toBeNull()
    expect(screen.getByTestId('discover-thumb')).not.toHaveClass('aspect-video')
  })
})
