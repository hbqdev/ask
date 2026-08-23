import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useSpeechPlayback } from '../use-speech-playback'

afterEach(() => vi.unstubAllGlobals())

describe('useSpeechPlayback', () => {
  it('fetches audio and transitions idle → loading → playing', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mpeg' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => blob }))
    // jsdom has no real audio; stub play()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined as never)

    const { result } = renderHook(() => useSpeechPlayback())
    expect(result.current.state).toBe('idle')
    await act(async () => { await result.current.speak('hello') })
    await waitFor(() => expect(result.current.state).toBe('playing'))
    expect(fetch).toHaveBeenCalledWith('/api/voice/speak', expect.objectContaining({ method: 'POST' }))
  })

  it('returns to idle and does not throw when /speak fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    const { result } = renderHook(() => useSpeechPlayback())
    await act(async () => { await result.current.speak('hi') })
    expect(result.current.state).toBe('idle')
  })
})
