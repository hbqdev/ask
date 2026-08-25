import { ttsServiceUrl, ttsSpeed, ttsVoice } from './config'

// POST text to the self-hosted Kokoro service and return its streaming audio
// body so the route can pipe it straight to the browser (progressive playback).
export async function synthesizeSpeech(
  text: string,
  opts: { voice?: string; speed?: number; signal?: AbortSignal } = {}
): Promise<ReadableStream<Uint8Array>> {
  const base = ttsServiceUrl()
  if (!base) throw new Error('TTS service is not configured (TTS_SERVICE_URL)')

  // Kokoro-FastAPI speaks the OpenAI-compatible Speech API: POST
  // /v1/audio/speech with { model, input, voice, response_format }. We pin
  // response_format to mp3 so the route can advertise audio/mpeg and the
  // browser gets a progressively-playable stream.
  const res = await fetch(`${base}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kokoro',
      input: text,
      voice: opts.voice ?? ttsVoice(),
      speed: opts.speed ?? ttsSpeed(),
      response_format: 'mp3'
    }),
    signal: opts.signal
  })
  if (!res.ok || !res.body) {
    throw new Error(`TTS service responded ${res.status}`)
  }
  return res.body
}
