import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { BackHeader } from '@/core/ui/BackHeader'

describe('BackHeader', () => {
  it('shows the title as the screen’s h1, centred between 48px side columns', () => {
    render(<BackHeader title="Privacy" onBack={() => {}} />)
    const heading = screen.getByRole('heading', { level: 1, name: 'Privacy' })
    const header = heading.closest('header')
    // px, not rem: a larger iOS text size leaves the title its room.
    expect(header).toHaveClass('grid-cols-[48px_minmax(0,1fr)_48px]')
    expect(heading).toHaveClass('truncate', 'text-center')
  })

  it('a 44 pt Back button calls onBack', () => {
    const onBack = vi.fn()
    render(<BackHeader title="Memory" onBack={onBack} />)
    const back = screen.getByRole('button', { name: 'Back' })
    expect(back).toHaveClass('size-11')
    expect(back.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalledOnce()
  })
})
