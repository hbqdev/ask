import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useSpeechPlayback } from '../use-speech-playback'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks() // reset HTMLMediaElement.play spy so call counts don't leak
})

describe('useSpeechPlayback', () => {
  it('fetches audio and transitions idle → loading → playing', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mpeg' })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, blob: async () => blob })
    )
    // jsdom has no real audio; stub play()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(
      undefined as never
    )

    const { result } = renderHook(() => useSpeechPlayback())
    expect(result.current.state).toBe('idle')
    await act(async () => {
      await result.current.speak('hello')
    })
    await waitFor(() => expect(result.current.state).toBe('playing'))
    expect(fetch).toHaveBeenCalledWith(
      '/api/voice/speak',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('returns to idle and does not throw when /speak fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 })
    )
    const { result } = renderHook(() => useSpeechPlayback())
    await act(async () => {
      await result.current.speak('hi')
    })
    expect(result.current.state).toBe('idle')
  })

  it('is single-flight: a second speak() aborts the first, only one audio plays', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mpeg' })
    const signals: AbortSignal[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, opts: { signal: AbortSignal }) => {
        signals.push(opts.signal)
        // In flight for a beat so both requests overlap, as they do when the
        // auto-play effect fires more than once for the same answer.
        return new Promise(resolve =>
          setTimeout(() => resolve({ ok: true, blob: async () => blob }), 10)
        )
      })
    )
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined as never)

    const { result } = renderHook(() => useSpeechPlayback())
    await act(async () => {
      void result.current.speak('first') // left in flight
      void result.current.speak('second') // supersedes it
      await new Promise(r => setTimeout(r, 40))
    })

    expect(signals[0].aborted).toBe(true) // first request cancelled
    expect(signals[1].aborted).toBe(false) // second proceeds
    expect(playSpy).toHaveBeenCalledTimes(1) // exactly one audio ever plays
    expect(result.current.state).toBe('playing')
  })
})
