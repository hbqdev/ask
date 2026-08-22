import { afterEach, describe, expect, it, vi } from 'vitest'

// `newMock` is referenced inside the hoisted vi.mock factory, so it must be
// created via vi.hoisted or it is not initialised when the factory runs.
const { newMock } = vi.hoisted(() => ({ newMock: vi.fn() }))
vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: { new: newMock }
}))

import { createSpeechDetector } from '@/lib/voice/vad'

afterEach(() => vi.clearAllMocks())

describe('createSpeechDetector', () => {
  it('creates a MicVAD pointed at local assets and wires callbacks', async () => {
    const instance = { start: vi.fn(), pause: vi.fn(), destroy: vi.fn() }
    newMock.mockResolvedValue(instance)
    const onSpeechEnd = vi.fn()

    const det = await createSpeechDetector({ onSpeechEnd })

    const opts = newMock.mock.calls[0][0]
    expect(opts.baseAssetPath).toBe('/vad/')
    expect(opts.onnxWASMBasePath).toBe('/vad/')
    // the wrapper forwards VAD's Float32 PCM straight through
    const pcm = new Float32Array([0.1, 0.2])
    opts.onSpeechEnd(pcm)
    expect(onSpeechEnd).toHaveBeenCalledWith(pcm)

    det.start()
    det.pause()
    det.destroy()
    expect(instance.start).toHaveBeenCalled()
    expect(instance.pause).toHaveBeenCalled()
    expect(instance.destroy).toHaveBeenCalled()
  })
})
