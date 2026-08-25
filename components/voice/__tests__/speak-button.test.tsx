import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_TTS_SPEED, DEFAULT_TTS_VOICE } from '@/lib/voice/voices'

const speak = vi.fn()
vi.mock('@/hooks/use-speech-playback', () => ({
  useSpeechPlayback: () => ({ speak, stop: vi.fn(), state: 'idle' })
}))
import { SpeakButton } from '../speak-button'

// With no stored preference, the button speaks with the default voice + speed.
const defaultOpts = { voice: DEFAULT_TTS_VOICE, speed: DEFAULT_TTS_SPEED }

describe('SpeakButton', () => {
  it('speaks the gist text on click', () => {
    render(<SpeakButton gistText="hello there" autoPlay={false} />)
    fireEvent.click(screen.getByRole('button', { name: /listen|speak/i }))
    expect(speak).toHaveBeenCalledWith('hello there', defaultOpts)
  })

  it('auto-plays when autoPlay is true and gist is present', () => {
    render(<SpeakButton gistText="auto play me" autoPlay />)
    expect(speak).toHaveBeenCalledWith('auto play me', defaultOpts)
  })

  it('renders nothing without gist text', () => {
    const { container } = render(<SpeakButton gistText="" autoPlay={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})
