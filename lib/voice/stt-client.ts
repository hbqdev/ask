import { sttModelId, whisperServiceUrl } from './config'

// POST recorded audio to the self-hosted Whisper service (OpenAI-compatible
// transcription API) and return the transcript. Mirrors tts-client's
// synthesizeSpeech: the service speaks the OpenAI /v1/audio/transcriptions
// contract (multipart form: file, model, response_format=json → { text }).
export async function transcribeAudio(
  audio: Blob,
  opts: { model?: string; signal?: AbortSignal } = {}
): Promise<string> {
  const base = whisperServiceUrl()
  if (!base) {
    throw new Error('STT service is not configured (WHISPER_SERVICE_URL)')
  }

  const form = new FormData()
  form.append('file', audio, 'audio.webm')
  form.append('model', opts.model ?? sttModelId())
  form.append('response_format', 'json')

  const res = await fetch(`${base}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
    signal: opts.signal
  })
  if (!res.ok) throw new Error(`STT service responded ${res.status}`)

  const data = (await res.json()) as { text?: unknown }
  if (typeof data.text !== 'string') {
    throw new Error('STT service returned no text')
  }
  return data.text.trim()
}
