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
    const { container } = render(
      <DiscoverLeadCard item={ITEM} {...handlers()} />
    )
    expect(screen.getByTestId('discover-thumb')).toHaveClass('aspect-video')
    // On an iPad's wide column the 16:9 image is capped, cropped to fill.
    expect(screen.getByTestId('discover-thumb')).toHaveClass('max-h-[360px]')
    expect(image(container)).toHaveClass('object-cover')
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

  it('draws an inset hairline under it only with a separator', () => {
    const { rerender } = render(<DiscoverRow item={ITEM} {...handlers()} />)
    const row = screen.getByRole('listitem')
    expect(row.className).not.toContain('border-b')
    expect(row.className).not.toContain('after:')
    rerender(<DiscoverRow item={ITEM} {...handlers()} separator />)
    expect(row).toHaveClass('relative', 'after:h-px', 'after:left-4')
  })

  it('ends its hairline where the lead card ends, 16 px in from the right', () => {
    // The lead card sits 16 px in from both edges (mx-4); the hairline starts
    // at the thumbnail (16 px in) and stops 16 px short of the right, so on
    // an iPad's readable column the rows and the card share a right edge.
    render(<DiscoverLeadCard item={ITEM} {...handlers()} />)
    expect(screen.getByTestId('discover-lead')).toHaveClass('mx-4')
    render(<DiscoverRow item={ITEM} {...handlers()} separator />)
    const row = screen.getByRole('listitem')
    expect(row).toHaveClass('after:left-4', 'after:right-4')
    expect(row).not.toHaveClass('after:right-0')
  })

  it('sizes the title in rem, so it follows the text size', () => {
    render(<DiscoverRow item={ITEM} {...handlers()} />)
    // 15px at the default 16px root.
    expect(screen.getByText('Chips get faster')).toHaveClass('text-[0.9375rem]')
  })
})
