// One dictation's transcription by Ask's Whisper route (code map §7): the
// audio as the multipart field `file`, answered with {text}. The route answers
// the app's CORS itself, outside the proxy, so the recording arrives whole.

import { NETWORK_ERROR_MESSAGE } from '@/core/api/client'
import { ApiError, toApiError } from '@/core/api/errors'

export const TOO_LONG_MESSAGE = 'Recording too long'
export const UNAVAILABLE_MESSAGE = 'Voice is unavailable right now'

export type TranscribeOptions = {
  baseUrl: string
  token: string
  audio: Blob
  signal?: AbortSignal
}

/** The upload's name: iOS records mp4 (.m4a); other browsers may give webm. */
export function audioFilename(type: string): string {
  return type.includes('webm') ? 'audio.webm' : 'audio.m4a'
}

/** The trimmed transcript (empty when nothing was heard). */
export async function transcribe({
  baseUrl,
  token,
  audio,
  signal
}: TranscribeOptions): Promise<string> {
  const form = new FormData()
  form.append('file', audio, audioFilename(audio.type))

  let res: Response
  try {
    res = await fetch(`${baseUrl}/api/voice/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ApiError(0, NETWORK_ERROR_MESSAGE, { retryable: true })
  }

  if (res.status === 413) throw new ApiError(413, TOO_LONG_MESSAGE)
  // 503: the speech service is down; 404: voice is turned off on the server.
  if (res.status === 503 || res.status === 404) {
    throw new ApiError(res.status, UNAVAILABLE_MESSAGE)
  }
  if (!res.ok) throw await toApiError(res)

  const body = (await res.json().catch(() => ({}))) as { text?: unknown }
  return typeof body.text === 'string' ? body.text.trim() : ''
}
