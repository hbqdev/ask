import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const speak = vi.fn()
vi.mock('@/hooks/use-speech-playback', () => ({
  useSpeechPlayback: () => ({ speak, stop: vi.fn(), state: 'idle' })
}))
import { SpeakButton } from '../speak-button'

describe('SpeakButton', () => {
  it('speaks the gist text on click', () => {
    render(<SpeakButton gistText="hello there" autoPlay={false} />)
    fireEvent.click(screen.getByRole('button', { name: /listen|speak/i }))
    expect(speak).toHaveBeenCalledWith('hello there')
  })

  it('auto-plays when autoPlay is true and gist is present', () => {
    render(<SpeakButton gistText="auto play me" autoPlay />)
    expect(speak).toHaveBeenCalledWith('auto play me')
  })

  it('renders nothing without gist text', () => {
    const { container } = render(<SpeakButton gistText="" autoPlay={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})
