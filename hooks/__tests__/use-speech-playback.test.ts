import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useSpeechPlayback } from '../use-speech-playback'

afterEach(() => vi.unstubAllGlobals())

// A fully controlled stand-in for the Audio element so the test can drive
// playback completion. speak() now resolves only when the element fires `ended`
// (or `error`, or stop() cuts playback) — a real jsdom media element never
// fires those on its own, so a bare `await speak()` would hang.
type FakeAudio = {
  play: () => Promise<void>
  pause: () => void
  src: string
  onended: (() => void) | null
  onerror: (() => void) | null
}
function stubAudio(): () => FakeAudio | null {
  let el: FakeAudio | null = null
  // A regular function, not an arrow: the hook calls `new Audio(url)`, and an
  // arrow (or arrow-backed vi.fn) is "not a constructor".
  function FakeAudioCtor(this: unknown): FakeAudio {
    el = {
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      src: '',
      onended: null,
      onerror: null
    }
    return el
  }
  vi.stubGlobal('Audio', FakeAudioCtor)
  return () => el
}

describe('useSpeechPlayback', () => {
  it('idle → loading → playing, then resolves + returns to idle only when playback ends', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mpeg' })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, blob: async () => blob })
    )
    const getAudio = stubAudio()

    const { result } = renderHook(() => useSpeechPlayback())
    expect(result.current.state).toBe('idle')

    let speakResolved = false
    let speakPromise!: Promise<void>
    await act(async () => {
      speakPromise = result.current.speak('hello').then(() => {
        speakResolved = true
      })
    })
    await waitFor(() => expect(result.current.state).toBe('playing'))
    expect(fetch).toHaveBeenCalledWith(
      '/api/voice/speak',
      expect.objectContaining({ method: 'POST' })
    )
    // Still playing → speak() must NOT have resolved yet (the self-talk guard).
    expect(speakResolved).toBe(false)

    // Playback completes → speak() resolves and state returns to idle.
    await act(async () => {
      getAudio()?.onended?.()
      await speakPromise
    })
    expect(result.current.state).toBe('idle')
    expect(speakResolved).toBe(true)
  })

  it('stop() settles a pending speak() and returns to idle', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mpeg' })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, blob: async () => blob })
    )
    stubAudio()

    const { result } = renderHook(() => useSpeechPlayback())
    let speakResolved = false
    let speakPromise!: Promise<void>
    await act(async () => {
      speakPromise = result.current.speak('hello').then(() => {
        speakResolved = true
      })
    })
    await waitFor(() => expect(result.current.state).toBe('playing'))

    // Cutting playback mid-flight must not leave speak()'s promise hanging.
    await act(async () => {
      result.current.stop()
      await speakPromise
    })
    expect(result.current.state).toBe('idle')
    expect(speakResolved).toBe(true)
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
})
