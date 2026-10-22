import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { FallbackImage } from '@/core/ui/FallbackImage'

describe('FallbackImage', () => {
  it('loads the image lazily and off the main thread', () => {
    render(
      <FallbackImage
        src="https://img.test.invalid/a.png"
        alt="A fox"
        className="size-full"
        fallback={<span>no image</span>}
      />
    )
    const img = screen.getByRole('img', { name: 'A fox' })
    expect(img).toHaveAttribute('src', 'https://img.test.invalid/a.png')
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(img).toHaveAttribute('decoding', 'async')
    expect(img).toHaveClass('size-full')
    expect(screen.queryByText('no image')).not.toBeInTheDocument()
  })

  it('passes other image props through', () => {
    const onPointerDown = vi.fn()
    render(
      <FallbackImage
        src="https://img.test.invalid/a.png"
        alt="A fox"
        style={{ touchAction: 'none' }}
        onPointerDown={onPointerDown}
        fallback={<span>no image</span>}
      />
    )
    const img = screen.getByRole('img', { name: 'A fox' })
    expect(img).toHaveStyle({ touchAction: 'none' })
    fireEvent.pointerDown(img)
    expect(onPointerDown).toHaveBeenCalledTimes(1)
  })

  it('shows the fallback instead of a broken image', () => {
    render(
      <FallbackImage
        src="https://img.test.invalid/a.png"
        alt="A fox"
        fallback={<span>no image</span>}
      />
    )
    fireEvent.error(screen.getByRole('img', { name: 'A fox' }))
    expect(screen.queryByRole('img', { name: 'A fox' })).not.toBeInTheDocument()
    expect(screen.getByText('no image')).toBeInTheDocument()
  })

  it('tries again when given a new source', () => {
    const view = render(
      <FallbackImage
        src="https://img.test.invalid/a.png"
        alt="A"
        fallback="x"
      />
    )
    fireEvent.error(screen.getByRole('img'))
    view.rerender(
      <FallbackImage
        src="https://img.test.invalid/b.png"
        alt="A"
        fallback="x"
      />
    )
    expect(screen.getByRole('img', { name: 'A' })).toHaveAttribute(
      'src',
      'https://img.test.invalid/b.png'
    )
  })
})
