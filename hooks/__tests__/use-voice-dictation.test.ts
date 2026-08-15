import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useVoiceDictation } from '../use-voice-dictation'

// Minimal MediaRecorder fake: stop() flushes one chunk then fires onstop.
class FakeRecorder {
  state = 'inactive'
  ondataavailable: ((e: { data: Blob }) => void) | undefined
  onstop: (() => void) | undefined
  mimeType = 'audio/webm'
  constructor(public stream: unknown) {}
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) })
    this.onstop?.()
  }
}

const fakeStream = () => ({ getTracks: () => [{ stop: vi.fn() }] })

afterEach(() => vi.restoreAllMocks())

describe('useVoiceDictation (click-to-toggle)', () => {
  it('records, then stop() transcribes and reports the transcript', async () => {
    ;(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder =
      FakeRecorder
    ;(navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue(fakeStream())
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: 'hello world' }), { status: 200 })
    )
    const onTranscript = vi.fn()
    const { result } = renderHook(() => useVoiceDictation(onTranscript))

    await act(async () => {
      await result.current.start()
    })
    expect(result.current.state).toBe('recording')
    expect(result.current.stream).toBeTruthy()

    await act(async () => {
      result.current.stop()
    })
    expect(onTranscript).toHaveBeenCalledWith('hello world')
    expect(result.current.state).toBe('idle')
    expect(result.current.stream).toBeNull()
  })

  it('cancel() discards without transcribing', async () => {
    ;(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder =
      FakeRecorder
    ;(navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue(fakeStream())
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const onTranscript = vi.fn()
    const { result } = renderHook(() => useVoiceDictation(onTranscript))
    await act(async () => {
      await result.current.start()
    })
    await act(async () => {
      result.current.cancel()
    })
    expect(onTranscript).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.current.state).toBe('idle')
  })

  it('returns to idle when mic permission is denied', async () => {
    ;(navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      getUserMedia: vi.fn().mockRejectedValue(new Error('denied'))
    }
    const { result } = renderHook(() => useVoiceDictation(vi.fn()))
    await act(async () => {
      await result.current.start()
    })
    expect(result.current.state).toBe('idle')
    expect(result.current.stream).toBeNull()
  })

  it('an empty recording short-circuits to idle without POSTing', async () => {
    class EmptyRecorder extends FakeRecorder {
      stop() {
        this.state = 'inactive'
        // no dataavailable -> chunks stay empty -> zero-byte blob
        this.onstop?.()
      }
    }
    ;(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder =
      EmptyRecorder
    ;(navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue(fakeStream())
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
})
