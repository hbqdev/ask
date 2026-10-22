import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import {
  DictationBar,
  formatElapsed,
  levelScale,
  MicButton
} from '@/features/voice/MicButton'
import type { Dictation } from '@/features/voice/useDictation'

function dictation(over: Partial<Dictation> = {}): Dictation {
  return {
    state: 'idle',
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    level: 0,
    seconds: 0,
    ...over
  }
}

describe('formatElapsed', () => {
  it('shows mm:ss', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(7)).toBe('00:07')
    expect(formatElapsed(65)).toBe('01:05')
    expect(formatElapsed(120)).toBe('02:00')
  })
})

describe('levelScale', () => {
  it('grows the ring with the level, up to a cap', () => {
    expect(levelScale(0)).toBe(1)
    expect(levelScale(0.1)).toBeGreaterThan(levelScale(0.05))
    expect(levelScale(1)).toBe(levelScale(0.5))
  })
})

describe('MicButton', () => {
  it('taps to start when idle', async () => {
    const user = userEvent.setup()
    const d = dictation()
    render(<MicButton dictation={d} />)
    await user.click(screen.getByRole('button', { name: 'Dictate' }))
    expect(d.start).toHaveBeenCalledTimes(1)
  })

  it('can start again after an error', async () => {
    const user = userEvent.setup()
    const d = dictation({ state: 'error', error: 'Nope' })
    render(<MicButton dictation={d} />)
    await user.click(screen.getByRole('button', { name: 'Dictate' }))
    expect(d.start).toHaveBeenCalledTimes(1)
  })

  it('while recording, taps again to stop, inside a ring that follows the level', async () => {
    const user = userEvent.setup()
    const d = dictation({ state: 'recording', level: 0.1 })
    render(<MicButton dictation={d} />)
    const ring = screen.getByTestId('level-ring')
    expect(ring.style.transform).toBe(`scale(${levelScale(0.1)})`)

    await user.click(screen.getByRole('button', { name: 'Stop recording' }))
    expect(d.stop).toHaveBeenCalledTimes(1)
    expect(d.start).not.toHaveBeenCalled()
  })

  it('cannot be tapped while transcribing', () => {
    render(<MicButton dictation={dictation({ state: 'transcribing' })} />)
    expect(screen.getByRole('button', { name: 'Transcribing' })).toBeDisabled()
    expect(screen.queryByTestId('level-ring')).not.toBeInTheDocument()
  })
})

describe('DictationBar', () => {
  it('shows nothing when not dictating', () => {
    const { container, rerender } = render(
      <DictationBar dictation={dictation()} />
    )
    expect(container).toBeEmptyDOMElement()
    rerender(<DictationBar dictation={dictation({ state: 'error' })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('while recording shows the timer and a cancel', async () => {
    const user = userEvent.setup()
    const d = dictation({ state: 'recording', seconds: 7 })
    render(<DictationBar dictation={d} />)
    expect(screen.getByRole('timer')).toHaveTextContent('00:07')

    await user.click(screen.getByRole('button', { name: 'Cancel recording' }))
    expect(d.cancel).toHaveBeenCalledTimes(1)
    expect(d.stop).not.toHaveBeenCalled()
  })

  it('while transcribing shows a spinner and nothing to tap', () => {
    render(<DictationBar dictation={dictation({ state: 'transcribing' })} />)
    expect(screen.getByRole('status')).toHaveTextContent('Transcribing…')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('timer')).not.toBeInTheDocument()
  })
})
