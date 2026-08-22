import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MicButton } from '../mic-button'

describe('MicButton (tap-or-hold dictate trigger)', () => {
  it('calls onPressStart on pointerdown (recording starts on press)', () => {
    const onPressStart = vi.fn()
    render(<MicButton onPressStart={onPressStart} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: /dictate/i }))
    expect(onPressStart).toHaveBeenCalledTimes(1)
  })

  it('calls onPressStart on click (keyboard Enter/Space path)', () => {
    const onPressStart = vi.fn()
    render(<MicButton onPressStart={onPressStart} />)
    fireEvent.click(screen.getByRole('button', { name: /dictate/i }))
    expect(onPressStart).toHaveBeenCalledTimes(1)
  })

  it('does not fire onPressStart when disabled', () => {
    // jsdom suppresses click on a disabled <button> (as real browsers do for all
    // events); pointerdown isn't gated in jsdom, so click is the honest assertion.
    const onPressStart = vi.fn()
    render(<MicButton onPressStart={onPressStart} disabled />)
    fireEvent.click(screen.getByRole('button', { name: /dictate/i }))
    expect(onPressStart).not.toHaveBeenCalled()
  })
})
