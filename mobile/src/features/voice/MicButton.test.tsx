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
import { clippingAncestors } from '@/test/clipping'

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

  it('shows a pending ring while the microphone opens; a tap cancels', async () => {
    const user = userEvent.setup()
    const d = dictation({ state: 'starting' })
    render(<MicButton dictation={d} />)
    expect(screen.getByTestId('starting-ring')).toBeInTheDocument()
    expect(screen.queryByTestId('level-ring')).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Starting microphone' })
    )
    expect(d.cancel).toHaveBeenCalledTimes(1)
    expect(d.start).not.toHaveBeenCalled()
  })

  it('does nothing when tapped while transcribing, yet keeps its focus', async () => {
    const user = userEvent.setup()
    const d = dictation({ state: 'transcribing' })
    render(<MicButton dictation={d} />)
    const button = screen.getByRole('button', { name: 'Transcribing' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByTestId('level-ring')).not.toBeInTheDocument()
    await user.click(button)
    expect(d.start).not.toHaveBeenCalled()
    expect(d.stop).not.toHaveBeenCalled()
    expect(d.cancel).not.toHaveBeenCalled()
  })

  it('keeps its 36 px look in every state, with a 44-pt hit area over its rings, unclipped', () => {
    const { container, rerender } = render(
      <MicButton dictation={dictation()} />
    )
    for (const state of [
      'idle',
      'starting',
      'recording',
      'transcribing',
      'error'
    ] as const) {
      rerender(<MicButton dictation={dictation({ state })} />)
      const button = screen.getByRole('button')
      expect(button, state).toHaveClass('hit-target', 'size-9')
      expect(clippingAncestors(button, container), state).toEqual([])
      // After the rings, so it and its hit area are over them.
      expect(button.parentElement!.lastElementChild, state).toBe(button)
    }
  })

  it('is one button throughout, so VoiceOver focus stays on it', () => {
    const { rerender } = render(<MicButton dictation={dictation()} />)
    const button = screen.getByRole('button', { name: 'Dictate' })
    button.focus()
    for (const state of [
      'starting',
      'recording',
      'transcribing',
      'idle',
      'error'
    ] as const) {
      rerender(<MicButton dictation={dictation({ state })} />)
      expect(screen.getByRole('button')).toBe(button)
      expect(document.activeElement).toBe(button)
    }
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
    rerender(<DictationBar dictation={dictation({ state: 'starting' })} />)
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

  it('each cancel keeps its 36 px look, with a 44-pt hit area layered over the row below', () => {
    // The bar is 40 px tall, so the hit area reaches 2 px into the button
    // row under it, where Attach (off while dictating) reaches 4 px up: the
    // cancel is raised (z-index 1) so the overlap is the live cancel's.
    const { container, rerender } = render(
      <DictationBar dictation={dictation({ state: 'recording' })} />
    )
    const check = (name: string) => {
      const cancel = screen.getByRole('button', { name })
      expect(cancel).toHaveClass('hit-target', 'size-9', 'z-[1]')
      expect(clippingAncestors(cancel, container)).toEqual([])
    }
    check('Cancel recording')
    rerender(<DictationBar dictation={dictation({ state: 'transcribing' })} />)
    check('Cancel transcription')
  })

  it('while transcribing shows a spinner and a cancel that abandons it', async () => {
    const user = userEvent.setup()
    const d = dictation({ state: 'transcribing' })
    render(<DictationBar dictation={d} />)
    expect(screen.getByRole('status')).toHaveTextContent('Transcribing…')
    expect(screen.queryByRole('timer')).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Cancel transcription' })
    )
    expect(d.cancel).toHaveBeenCalledTimes(1)
    expect(d.stop).not.toHaveBeenCalled()
  })
})
