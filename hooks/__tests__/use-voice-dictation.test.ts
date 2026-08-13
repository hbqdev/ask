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
})
