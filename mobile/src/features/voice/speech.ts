// Reading answers aloud with Ask's Kokoro TTS (code map §7): speak() fetches
// the whole answer's audio from /api/voice/speak, and one app-wide player
// plays it. The route streams mp3, but the iOS web view likely can't play
// audio/mpeg through MediaSource, so the audio is read in full and played
// from an object URL, the web's own fallback (hooks/use-speech-playback.ts).

import { NETWORK_ERROR_MESSAGE } from '@/core/api/client'
import { ApiError, toApiError } from '@/core/api/errors'
import { UNAVAILABLE_MESSAGE } from '@/features/voice/transcribe'
import { firstSentences, stripForSpeech } from '@/lib/voice/strip-for-speech'
import { clampSpeed } from '@/lib/voice/voices'

/** The most the speak route reads in one go, in characters. */
export const SPOKEN_MAX_CHARS = 20_000

/**
 * An answer as it is read aloud: no citations, spec fences, code, tables,
 * URLs or markdown; a long one is cut at the last whole sentence that fits.
 * The same cleaning the server gives the spoken answer it streams
 * (lib/voice/emit-spoken-gist.ts).
 */
export function speakableText(text: string): string {
  const spoken = stripForSpeech(text)
  if (spoken.length <= SPOKEN_MAX_CHARS) return spoken
  // Every whole sentence in the head; the head itself when it has none.
  return firstSentences(spoken.slice(0, SPOKEN_MAX_CHARS), Infinity)
}

export type SpeakOptions = {
  baseUrl: string
  token: string
  text: string
  /** A Kokoro voice id; the server's default when left out. */
  voice?: string
  /** The speed multiplier, clamped to what Kokoro supports. */
  speed?: number
  signal?: AbortSignal
}

/** The audio of `text` read aloud (audio/mpeg). */
export async function speak({
  baseUrl,
  token,
  text,
  voice,
  speed,
  signal
}: SpeakOptions): Promise<Blob> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/api/voice/speak`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        voice,
        speed: speed === undefined ? undefined : clampSpeed(speed)
      }),
      signal
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ApiError(0, NETWORK_ERROR_MESSAGE, { retryable: true })
  }

  // 503: the speech service is down; 404: voice is turned off on the server.
  if (res.status === 503 || res.status === 404) {
    throw new ApiError(res.status, UNAVAILABLE_MESSAGE)
  }
  if (!res.ok) throw await toApiError(res)
  return res.blob()
}

// --- The player ---------------------------------------------------------------
// One audio element for the whole app, so only one answer is ever read at a
// time. Each playback has an owner (the message being read), so every control
// for that message shows it playing, wherever it was started.

export type PlayerListener = (owner: string | null) => void

let element: HTMLAudioElement | null = null
let current: { owner: string; url: string } | null = null
const listeners = new Set<PlayerListener>()

function emit() {
  const owner = current?.owner ?? null
  listeners.forEach(listener => listener(owner))
}

/** Ends the current playback and frees its audio; tells no one. */
function release(): boolean {
  if (!current) return false
  const audio = element!
  audio.onended = null
  audio.onerror = null
  audio.onpause = null
  audio.pause()
  audio.removeAttribute('src')
  URL.revokeObjectURL(current.url)
  current = null
  return true
}

/** The owner of what is playing now ('' when unnamed), or null. */
export function playingOwner(): string | null {
  return current?.owner ?? null
}

/** Stops what is playing, if anything, and frees its audio. */
export function stop(): void {
  if (release()) emit()
}

/**
 * Plays `blob`, stopping whatever played before. Resolves once it is
 * playing (or once it was stopped before it could start); rejects when it
 * cannot play. Its audio is freed when it ends, is stopped, fails, or is
 * paused by the system (a call, Siri).
 */
export async function play(blob: Blob, owner = ''): Promise<void> {
  release()
  element ??= new Audio()
  const audio = element
  const playback = { owner, url: URL.createObjectURL(blob) }
  current = playback
  const finish = () => {
    if (current === playback) stop()
  }
  audio.onended = finish
  audio.onerror = finish
  // A pause not of our making (release() clears these first) is the system
  // taking the audio: a call, Siri, another app. It is not resumed: done.
  audio.onpause = finish
  audio.src = playback.url
  emit()
  try {
    await audio.play()
  } catch (error) {
    // Stopped or replaced before it started: the play() was interrupted.
    if (current !== playback) return
    stop()
    throw error
  }
}

/** Calls `listener` with the new owner whenever playback starts or stops. */
export function onStateChange(listener: PlayerListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
