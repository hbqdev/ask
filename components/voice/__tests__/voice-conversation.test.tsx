import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const endFn = vi.fn()
const setMuted = vi.fn()
vi.mock('@/hooks/use-voice-conversation', () => ({
  useVoiceConversation: () => ({
    phase: 'listening',
    transcript: 'hello there',
    errorText: null,
    muted: false,
    setMuted,
    end: endFn
  })
}))
vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({ messages: [], status: 'ready', sendMessage: vi.fn() })
}))
vi.mock('ai', () => ({ DefaultChatTransport: class {} }))
vi.mock('@/lib/db/schema', () => ({ generateId: () => 'cid' }))
vi.mock('@/hooks/use-speech-playback', () => ({
  useSpeechPlayback: () => ({ speak: vi.fn(), stop: vi.fn(), state: 'idle' })
}))
vi.mock('@/lib/voice/vad', () => ({ createSpeechDetector: vi.fn() }))
vi.mock('@/components/ui/wild-breath-field', () => ({
  __esModule: true,
  default: ({ intensity }: { intensity?: number }) => (
    <div data-testid="field" data-intensity={intensity} />
  ),
  WildBreathField: ({ intensity }: { intensity?: number }) => (
    <div data-testid="field" data-intensity={intensity} />
  )
}))
vi.mock('@/components/source-favicons', () => ({
  SourceFavicons: () => <div data-testid="sources" />
}))

import { VoiceConversation } from '@/components/voice/voice-conversation'

afterEach(() => vi.clearAllMocks())

describe('VoiceConversation', () => {
  it('renders the live transcript and the reactive field', () => {
    render(<VoiceConversation onClose={vi.fn()} />)
    expect(screen.getByText('hello there')).toBeInTheDocument()
    expect(screen.getByTestId('field')).toBeInTheDocument()
  })

  it('ends and closes on the End control', () => {
    const onClose = vi.fn()
    render(<VoiceConversation onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /end/i }))
    expect(endFn).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
