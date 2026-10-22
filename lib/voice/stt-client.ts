import { sttModelId, whisperServiceUrl } from './config'

// A hung Whisper must not hold the request (and the user's composer) forever.
const STT_TIMEOUT_MS = 60_000

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

  const timeout = new AbortController()
  const timer = setTimeout(
    () => timeout.abort(new Error('STT service timed out')),
    STT_TIMEOUT_MS
  )
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeout.signal])
    : timeout.signal
  let data: { text?: unknown }
  try {
    const res = await fetch(`${base}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
      signal
    })
    if (!res.ok) throw new Error(`STT service responded ${res.status}`)
    data = (await res.json()) as { text?: unknown }
  } catch (e) {
    if (timeout.signal.aborted) throw timeout.signal.reason
    throw e
  } finally {
    clearTimeout(timer)
  }
  if (typeof data.text !== 'string') {
    throw new Error('STT service returned no text')
  }
  return data.text.trim()
}
