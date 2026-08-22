// lib/voice/wav.ts
// Encode mono Float32 PCM in [-1, 1] as a 16-bit PCM WAV Blob. The browser
// Silero VAD hands us raw Float32 PCM @16kHz; /api/voice/transcribe wants a
// file, and Whisper reads WAV via the OpenAI transcription contract.
export function encodeWav(pcm: Float32Array, sampleRate = 16000): Blob {
  const frames = pcm.length
  const buffer = new ArrayBuffer(44 + frames * 2)
  const view = new DataView(buffer)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + frames * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate (mono, 2 bytes/sample)
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, frames * 2, true)
  let off = 44
  for (let i = 0; i < frames; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
