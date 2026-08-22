import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RecordingBar } from '../recording-bar'

// WaveformVisualizer bails out when stream is null (no AudioContext in jsdom),
// so passing null keeps these tests focused on the bar's controls + states.
describe('RecordingBar', () => {
  it('shows Listening + timer and fires stop/cancel while recording', () => {
    const onStop = vi.fn()
    const onCancel = vi.fn()
    render(
      <RecordingBar
        stream={null}
        state="recording"
        onStop={onStop}
        onCancel={onCancel}
      />
    )
    expect(screen.getByText(/listening/i)).toBeTruthy()
    expect(screen.getByText('0:00')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /cancel recording/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /stop and send/i }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('shows a Transcribing state (no controls) when transcribing', () => {
    render(
      <RecordingBar
        stream={null}
        state="transcribing"
        onStop={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText(/transcribing/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /stop and send/i })).toBeNull()
  })
})
