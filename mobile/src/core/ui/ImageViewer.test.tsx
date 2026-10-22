import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { haptic } from '@/core/haptics'
import { ImageViewer } from '@/core/ui/ImageViewer'

vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))

const IMAGES = ['1', '2', '3', '4', '5'].map(n => ({
  src: `https://img.test.invalid/${n}.png`,
  alt: `${n}.png`
}))

function setup(start = 0, images = IMAGES, open = true) {
  const onClose = vi.fn()
  const view = render(
    <ImageViewer open={open} images={images} start={start} onClose={onClose} />
  )
  return { onClose, ...view }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(haptic).mockClear()
})

describe('ImageViewer', () => {
  it('renders nothing while closed', () => {
    setup(0, IMAGES, false)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('covers the whole screen in black over the page, with every image', () => {
    const { container } = setup(1)
    const viewer = screen.getByRole('dialog', { name: 'Image 2 of 5' })
    expect(viewer).toHaveAttribute('aria-modal', 'true')
    expect(viewer).toHaveClass('fixed', 'inset-0', 'bg-black')
    // Portalled to the body, outside the caller's tree.
    expect(container).toBeEmptyDOMElement()
    expect(viewer.parentElement).toBe(document.body)
    expect(within(viewer).getAllByRole('img')).toHaveLength(5)
    expect(viewer).toHaveFocus()
  })

  it('shows the page it is on', () => {
    setup(1)
    expect(screen.getByText('2 / 5')).toBeVisible()
  })

  it('shows no pages and a plain name for a single image', () => {
    setup(0, IMAGES.slice(0, 1))
    expect(screen.getByRole('dialog', { name: 'Image' })).toBeInTheDocument()
    expect(screen.queryByText('1 / 1')).not.toBeInTheDocument()
  })

  it('opens scrolled to the start image, and follows a swipe', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390)
    setup(3)
    const strip = screen.getByTestId('viewer-strip')
    expect(strip.scrollLeft).toBe(3 * 390)

    strip.scrollLeft = 380
    fireEvent.scroll(strip)
    expect(screen.getByText('2 / 5')).toBeVisible()
    expect(screen.getByRole('dialog', { name: 'Image 2 of 5' })).toBeVisible()
  })

  it('keeps the page in range when the scroll overshoots', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
    setup(0)
    const strip = screen.getByTestId('viewer-strip')
    strip.scrollLeft = 900
    fireEvent.scroll(strip)
    expect(screen.getByText('5 / 5')).toBeVisible()
    strip.scrollLeft = -80
    fireEvent.scroll(strip)
    expect(screen.getByText('1 / 5')).toBeVisible()
  })

  it('closes from the close button with a light tap', () => {
    const { onClose } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(haptic).toHaveBeenCalledWith('light')
  })

  it('closes on Escape, and stops listening once gone', () => {
    const { onClose, unmount } = setup()
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows a placeholder for an image that fails to load', () => {
    setup()
    fireEvent.error(screen.getByRole('img', { name: '1.png' }))
    expect(screen.getByTestId('viewer-placeholder')).toBeInTheDocument()
  })
})
