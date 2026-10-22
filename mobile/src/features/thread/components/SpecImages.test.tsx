import { Browser } from '@capacitor/browser'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SpecImages } from '@/features/thread/components/SpecImages'

vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(async () => {}) }
}))

const IMAGES = [
  {
    src: 'https://img.test.invalid/1.jpg',
    title: 'First',
    sourceUrl: 'https://news.test.invalid/story'
  },
  { src: 'https://img.test.invalid/2.jpg' }
]

beforeEach(() => {
  vi.mocked(Browser.open).mockClear()
})

describe('SpecImages', () => {
  it('renders nothing with no images', () => {
    const { container } = render(<SpecImages images={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders each image in a horizontal scroller', () => {
    const { container } = render(<SpecImages images={IMAGES} />)
    const imgs = [...container.querySelectorAll('img')]
    expect(imgs.map(i => i.getAttribute('src'))).toEqual([
      'https://img.test.invalid/1.jpg',
      'https://img.test.invalid/2.jpg'
    ])
    expect(screen.getByRole('img', { name: 'First' })).toBeInTheDocument()
    expect(screen.getByText('First')).toBeInTheDocument()
  })

  it('offers each image’s own long-press menu, to save or copy it', () => {
    const { container } = render(<SpecImages images={IMAGES} />)
    for (const img of container.querySelectorAll('img')) {
      expect(img).toHaveClass('selectable')
    }
  })

  it('opens the source page of an image on tap', () => {
    render(<SpecImages images={IMAGES} />)
    fireEvent.click(screen.getByRole('button', { name: /First/ }))
    expect(Browser.open).toHaveBeenCalledWith({
      url: 'https://news.test.invalid/story'
    })
  })

  it('opens the image itself when it has no source page', () => {
    render(<SpecImages images={IMAGES} />)
    fireEvent.click(screen.getAllByRole('button')[1])
    expect(Browser.open).toHaveBeenCalledWith({
      url: 'https://img.test.invalid/2.jpg'
    })
  })
})
