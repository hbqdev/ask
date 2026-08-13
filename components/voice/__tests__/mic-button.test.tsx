import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const start = vi.fn()
const stop = vi.fn()
let state: 'idle' | 'recording' | 'transcribing' = 'idle'

vi.mock('@/hooks/use-voice-dictation', () => ({
  useVoiceDictation: () => ({ state, start, stop })
}))

import { MicButton } from '../mic-button'

describe('MicButton', () => {
  beforeEach(() => {
    state = 'idle'
    start.mockClear()
    stop.mockClear()
  })

  it('starts on pointer down and stops on pointer up', () => {
    const { rerender } = render(<MicButton onTranscript={vi.fn()} />)
    const btn = screen.getByRole('button', { name: /dictate/i })
    fireEvent.pointerDown(btn)
    expect(start).toHaveBeenCalled()
    // start() would flip the real hook to 'recording' and re-render; the mock
    // hook holds no state, so drive that transition explicitly.
    state = 'recording'
    rerender(<MicButton onTranscript={vi.fn()} />)
    fireEvent.pointerUp(btn)
    expect(stop).toHaveBeenCalled()
  })

  it('stops when the pointer leaves while recording', () => {
    state = 'recording'
    render(<MicButton onTranscript={vi.fn()} />)
    fireEvent.pointerLeave(
      screen.getByRole('button', { name: /stop recording/i })
    )
    expect(stop).toHaveBeenCalled()
  })

  it('is disabled and never starts while transcribing', () => {
    state = 'transcribing'
    render(<MicButton onTranscript={vi.fn()} />)
    const btn = screen.getByRole('button', { name: /dictate/i })
    expect(btn).toBeDisabled()
    fireEvent.pointerDown(btn)
    expect(start).not.toHaveBeenCalled()
  })

  it('honors the disabled prop', () => {
    render(<MicButton onTranscript={vi.fn()} disabled />)
    expect(screen.getByRole('button', { name: /dictate/i })).toBeDisabled()
  })
})
