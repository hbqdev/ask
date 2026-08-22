import { MicVAD } from '@ricky0123/vad-web'

export interface SpeechDetector {
  start(): void
  pause(): void
  destroy(): void
}

export interface DetectorCallbacks {
  onSpeechStart?: () => void
  onSpeechEnd: (pcm: Float32Array) => void
}

// Silence endpointing tuned for conversational turns. vad-web@0.0.30 expresses
// these as milliseconds (not frame counts): redemptionMs≈1150 gives ~1.15s of
// trailing silence before a turn is considered finished, minSpeechMs≈350 ignores
// sub-350ms blips, and preSpeechPadMs≈300 prepends a little lead-in to each
// segment. Calibrate against real speech during the prod live-mic check.
const VAD_OPTS = {
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  redemptionMs: 1150,
  minSpeechMs: 350,
  preSpeechPadMs: 300,
  baseAssetPath: '/vad/',
  onnxWASMBasePath: '/vad/'
} as const

export async function createSpeechDetector(
  cb: DetectorCallbacks
): Promise<SpeechDetector> {
  const vad = await MicVAD.new({
    ...VAD_OPTS,
    onSpeechStart: cb.onSpeechStart,
    onSpeechEnd: (audio: Float32Array) => cb.onSpeechEnd(audio)
  })
  return {
    start: () => vad.start(),
    pause: () => vad.pause(),
    destroy: () => vad.destroy()
  }
}
