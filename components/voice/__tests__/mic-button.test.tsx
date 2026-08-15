import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MicButton } from '../mic-button'

describe('MicButton (click-to-dictate trigger)', () => {
  it('calls onStart when clicked', () => {
    const onStart = vi.fn()
    render(<MicButton onStart={onStart} />)
    fireEvent.click(screen.getByRole('button', { name: /dictate/i }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('does not fire onStart when disabled', () => {
    const onStart = vi.fn()
    render(<MicButton onStart={onStart} disabled />)
    fireEvent.click(screen.getByRole('button', { name: /dictate/i }))
    expect(onStart).not.toHaveBeenCalled()
  })
})
