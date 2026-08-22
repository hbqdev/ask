// @vitest-environment node
//
// Runs in the node environment (not the project-default jsdom): reading the
// encoded Blob back via `blob.arrayBuffer()` needs Node's native Blob. Under
// jsdom the global Blob is jsdom's, which does not implement arrayBuffer().
// Same pattern as app/api/voice/__tests__/transcribe.test.ts.
//
// lib/voice/__tests__/wav.test.ts
import { describe, expect, it } from 'vitest'

import { encodeWav } from '@/lib/voice/wav'

const ascii = (view: DataView, off: number, len: number) =>
  Array.from({ length: len }, (_, i) => String.fromCharCode(view.getUint8(off + i))).join('')

describe('encodeWav', () => {
  it('produces a 16-bit mono WAV blob with a correct header and samples', async () => {
    const pcm = new Float32Array([0, 1, -1, 0.5])
    const blob = encodeWav(pcm, 16000)

    expect(blob.type).toBe('audio/wav')
    expect(blob.size).toBe(44 + pcm.length * 2)

    const view = new DataView(await blob.arrayBuffer())
    expect(ascii(view, 0, 4)).toBe('RIFF')
    expect(ascii(view, 8, 4)).toBe('WAVE')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16000) // sample rate
    expect(view.getUint16(34, true)).toBe(16) // bits/sample
    expect(ascii(view, 36, 4)).toBe('data')
    // sample clamping: +1 -> 0x7fff, -1 -> -0x8000
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(0x7fff)
    expect(view.getInt16(48, true)).toBe(-0x8000)
  })
})
