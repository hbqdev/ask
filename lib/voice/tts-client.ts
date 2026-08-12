import { ttsServiceUrl, ttsVoice } from './config'

// POST text to the self-hosted Kokoro service and return its streaming audio
// body so the route can pipe it straight to the browser (progressive playback).
export async function synthesizeSpeech(
  text: string,
  opts: { voice?: string; signal?: AbortSignal } = {}
): Promise<ReadableStream<Uint8Array>> {
  const base = ttsServiceUrl()
  if (!base) throw new Error('TTS service is not configured (TTS_SERVICE_URL)')

  const res = await fetch(`${base}/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: opts.voice ?? ttsVoice() }),
    signal: opts.signal
  })
  if (!res.ok || !res.body) {
    throw new Error(`TTS service responded ${res.status}`)
  }
  return res.body
}
