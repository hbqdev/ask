import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TalkButton } from '@/components/voice/talk-button'

describe('TalkButton', () => {
  it('calls onClick when pressed', () => {
    const onClick = vi.fn()
    render(<TalkButton onClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: /talk|converse/i }))
    expect(onClick).toHaveBeenCalled()
  })

  it('does not fire onClick while disabled', () => {
    const onClick = vi.fn()
    render(<TalkButton onClick={onClick} disabled />)
    fireEvent.click(screen.getByRole('button', { name: /talk|converse/i }))
    expect(onClick).not.toHaveBeenCalled()
  })
})
