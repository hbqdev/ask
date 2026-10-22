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

/** Two quick taps in one place. */
function doubleTap(el: HTMLElement) {
  for (let i = 0; i < 2; i++) {
    fireEvent.pointerDown(el, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerUp(el, { clientX: 10, clientY: 10, pointerId: 1 })
  }
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

  it('gives focus back to what opened it once closed', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { unmount } = setup()
    expect(screen.getByRole('dialog')).toHaveFocus()
    unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })

  it('keeps Tab on its controls', () => {
    setup()
    const close = screen.getByRole('button', { name: 'Close' })
    fireEvent.keyDown(screen.getByRole('dialog'), {
      key: 'Tab',
      shiftKey: true
    })
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(close).toHaveFocus()
  })

  it('locks the page behind it from scrolling while open', () => {
    document.body.style.overflow = 'auto'
    const { unmount } = setup()
    expect(document.body.style.overflow).toBe('hidden')
    const strip = screen.getByTestId('viewer-strip')
    // A swipe pages sideways and never chains to the page behind.
    expect(strip).toHaveClass('overscroll-contain', 'touch-pan-x')
    unmount()
    expect(document.body.style.overflow).toBe('auto')
    document.body.style.overflow = ''
  })

  it('leaves pinching to the image, not the strip', () => {
    setup()
    const strip = screen.getByTestId('viewer-strip')
    expect(strip).toHaveClass('touch-pan-x')
    expect(strip).not.toHaveClass('touch-pinch-zoom')
    // Unzoomed, a swipe on the image still pages the strip.
    const img = screen.getByRole('img', { name: '1.png' })
    expect(img).toHaveStyle({
      transform: 'translate(0px, 0px) scale(1)',
      touchAction: 'pan-x'
    })
    expect(strip).not.toHaveStyle({ overflowX: 'hidden' })
  })

  it('zooms the image it is on with a double tap', () => {
    setup(1)
    const img = screen.getByRole('img', { name: '2.png' })
    doubleTap(img)
    expect(img).toHaveStyle({ transform: 'translate(0px, 0px) scale(2.5)' })
    // Clipped to its page.
    expect(img.parentElement).toHaveClass('overflow-hidden')
    // The others stay as they are, and take no gestures.
    const other = screen.getByRole('img', { name: '1.png' })
    expect(other.style.transform).toBe('')
    doubleTap(other)
    expect(other.style.transform).toBe('')
  })

  it('does not page while zoomed', () => {
    setup()
    const strip = screen.getByTestId('viewer-strip')
    const img = screen.getByRole('img', { name: '1.png' })
    doubleTap(img)
    // The strip stops scrolling and the image takes every touch, to pan.
    expect(strip).toHaveStyle({ overflowX: 'hidden' })
    expect(img).toHaveStyle({ touchAction: 'none' })
    doubleTap(img)
    expect(strip).not.toHaveStyle({ overflowX: 'hidden' })
    expect(img).toHaveStyle({ touchAction: 'pan-x' })
  })

  it('resets zoom when the page changes', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
    setup()
    const strip = screen.getByTestId('viewer-strip')
    doubleTap(screen.getByRole('img', { name: '1.png' }))
    // A page change that was already under way when the zoom began.
    strip.scrollLeft = 100
    fireEvent.scroll(strip)
    expect(screen.getByText('2 / 5')).toBeVisible()
    expect(strip).not.toHaveStyle({ overflowX: 'hidden' })
    expect(screen.getByRole('img', { name: '2.png' })).toHaveStyle({
      transform: 'translate(0px, 0px) scale(1)'
    })
    strip.scrollLeft = 0
    fireEvent.scroll(strip)
    expect(screen.getByRole('img', { name: '1.png' })).toHaveStyle({
      transform: 'translate(0px, 0px) scale(1)'
    })
  })

  it('a reopened viewer starts unzoomed', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <ImageViewer open images={IMAGES} start={0} onClose={onClose} />
    )
    doubleTap(screen.getByRole('img', { name: '1.png' }))
    rerender(
      <ImageViewer open={false} images={IMAGES} start={0} onClose={onClose} />
    )
    rerender(<ImageViewer open images={IMAGES} start={0} onClose={onClose} />)
    expect(screen.getByRole('img', { name: '1.png' })).toHaveStyle({
      transform: 'translate(0px, 0px) scale(1)'
    })
    expect(screen.getByTestId('viewer-strip')).not.toHaveStyle({
      overflowX: 'hidden'
    })
  })

  it('holds a light status bar while open', () => {
    const status = () =>
      document.documentElement.getAttribute('data-status-bar')
    expect(status()).toBeNull()
    const { unmount } = setup()
    // The viewer is black: light status-bar content over it.
    expect(status()).toBe('light')
    unmount()
    expect(status()).toBeNull()
  })

  it('releases the light status bar when closed', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <ImageViewer open images={IMAGES} start={0} onClose={onClose} />
    )
    expect(document.documentElement.dataset.statusBar).toBe('light')
    rerender(
      <ImageViewer open={false} images={IMAGES} start={0} onClose={onClose} />
    )
    expect(document.documentElement.dataset.statusBar).toBeUndefined()
  })
})
