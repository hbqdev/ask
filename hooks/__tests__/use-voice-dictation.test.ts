import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useVoiceDictation } from '../use-voice-dictation'

class FakeRecorder {
  state = 'inactive'
  ondataavailable: any
  onstop: any
  mimeType = 'audio/webm'
  constructor(public stream: any) {}
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) })
    this.onstop?.()
  }
}

// Same as FakeRecorder but emits a zero-byte chunk (silent/empty capture).
class EmptyRecorder extends FakeRecorder {
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob([], { type: 'audio/webm' }) })
    this.onstop?.()
  }
}

afterEach(() => vi.restoreAllMocks())

describe('useVoiceDictation', () => {
  it('records, transcribes, and reports the transcript', async () => {
    ;(globalThis as any).MediaRecorder = FakeRecorder
    ;(navigator as any).mediaDevices = {
      getUserMedia: vi
        .fn()
        .mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] })
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: 'hi there' }), { status: 200 })
    )
    const onTranscript = vi.fn()
    const { result } = renderHook(() => useVoiceDictation(onTranscript))

    await act(async () => {
      await result.current.start()
    })
    expect(result.current.state).toBe('recording')
    await act(async () => {
      result.current.stop()
    })
    expect(onTranscript).toHaveBeenCalledWith('hi there')
    expect(result.current.state).toBe('idle')
  })

  it('returns to idle when mic permission is denied', async () => {
    ;(navigator as any).mediaDevices = {
      getUserMedia: vi.fn().mockRejectedValue(new Error('denied'))
    }
    const { result } = renderHook(() => useVoiceDictation(vi.fn()))
    await act(async () => {
      await result.current.start()
    })
    expect(result.current.state).toBe('idle')
  })

  it('short-circuits to idle without POSTing when the blob is empty', async () => {
    ;(globalThis as any).MediaRecorder = EmptyRecorder
    ;(navigator as any).mediaDevices = {
      getUserMedia: vi
        .fn()
        .mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] })
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const onTranscript = vi.fn()
    const { result } = renderHook(() => useVoiceDictation(onTranscript))

    await act(async () => {
      await result.current.start()
    })
    await act(async () => {
      result.current.stop()
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(onTranscript).not.toHaveBeenCalled()
    expect(result.current.state).toBe('idle')
  })

  it('stays idle and skips onTranscript on a non-OK response', async () => {
    ;(globalThis as any).MediaRecorder = FakeRecorder
    ;(navigator as any).mediaDevices = {
      getUserMedia: vi
        .fn()
        .mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] })
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 500 })
    )
    const onTranscript = vi.fn()
    const { result } = renderHook(() => useVoiceDictation(onTranscript))

    await act(async () => {
      await result.current.start()
    })
    await act(async () => {
      result.current.stop()
    })
    expect(onTranscript).not.toHaveBeenCalled()
    expect(result.current.state).toBe('idle')
  })

  it('swallows a thrown fetch and returns to idle', async () => {
    ;(globalThis as any).MediaRecorder = FakeRecorder
    ;(navigator as any).mediaDevices = {
      getUserMedia: vi
        .fn()
        .mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] })
    }
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    const onTranscript = vi.fn()
    const { result } = renderHook(() => useVoiceDictation(onTranscript))

    await act(async () => {
      await result.current.start()
    })
    await act(async () => {
      result.current.stop()
    })
    expect(onTranscript).not.toHaveBeenCalled()
    expect(result.current.state).toBe('idle')
  })

  it('releases the mic and does not record when stopped before permission resolves', async () => {
    ;(globalThis as any).MediaRecorder = FakeRecorder
    const track = { stop: vi.fn() }
    let resolveGum: (v: any) => void = () => {}
    const gumPromise = new Promise(resolve => {
      resolveGum = resolve
    })
    ;(navigator as any).mediaDevices = {
      getUserMedia: vi.fn().mockReturnValue(gumPromise)
    }
    const recorderStart = vi.spyOn(FakeRecorder.prototype, 'start')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const onTranscript = vi.fn()
    const { result } = renderHook(() => useVoiceDictation(onTranscript))

    // start() begins but getUserMedia is still pending (permission prompt open).
    let startPromise: Promise<void> | undefined
    await act(async () => {
      startPromise = result.current.start()
    })
    // User releases the button before granting permission.
    act(() => {
      result.current.stop()
    })
    // Permission finally resolves and hands us the live stream.
    await act(async () => {
      resolveGum({ getTracks: () => [track] })
      await startPromise
    })

    expect(track.stop).toHaveBeenCalled()
    expect(recorderStart).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(onTranscript).not.toHaveBeenCalled()
    expect(result.current.state).toBe('idle')
  })
})
