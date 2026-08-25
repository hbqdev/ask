'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

type PlaybackState = 'idle' | 'loading' | 'playing'

// Pump a fetch body stream into an open MediaSource's mp3 SourceBuffer chunk by
// chunk, so playback can begin from the first bytes. Appends are serialised (one
// appendBuffer at a time) and stop on abort. Resolves when the stream ends.
async function pumpIntoSourceBuffer(
  mediaSource: MediaSource,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): Promise<void> {
  let sourceBuffer: SourceBuffer
  try {
    sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg')
  } catch {
    return
  }
  const reader = body.getReader()
  const appendChunk = (chunk: Uint8Array) =>
    new Promise<void>((resolve, reject) => {
      sourceBuffer.addEventListener('updateend', () => resolve(), {
        once: true
      })
      sourceBuffer.addEventListener('error', () => reject(new Error('sb')), {
        once: true
      })
      // Cast around lib.dom's strict BufferSource typing (a Uint8Array from the
      // stream is a valid append source at runtime regardless of its backing).
      sourceBuffer.appendBuffer(chunk as unknown as BufferSource)
    })
  try {
    for (;;) {
      if (signal.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength) await appendChunk(value)
    }
  } catch {
    /* aborted or a demux error — playback just stops with what it has */
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* reader already released */
    }
    try {
      if (mediaSource.readyState === 'open') mediaSource.endOfStream()
    } catch {
      /* source already detached/closed */
    }
  }
}

// Fetches TTS audio for a gist and plays it. Fail-quiet: any error returns to
// idle without throwing, so a TTS outage never breaks the UI.
//
// SINGLE-FLIGHT: only ever one playback at a time. Each speak()/stop() bumps a
// generation counter and aborts the prior request; any async continuation from
// a superseded call bails without creating or playing audio.
//
// PROGRESSIVE: Kokoro streams the mp3 (first byte in milliseconds), so where the
// browser supports MSE audio we play from the first chunk instead of buffering
// the whole clip — time-to-first-audio drops from full-synthesis (several
// seconds for a long answer) to a fraction of a second. Browsers without MSE
// audio (e.g. some Safari) fall back to buffered playback.
export function useSpeechPlayback() {
  const [state, setState] = useState<PlaybackState>('idle')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const genRef = useRef(0)

  // Tear down the current audio + in-flight fetch + object URL. Does NOT bump
  // the generation (callers that mean to supersede bump it themselves).
  const teardown = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.onended = null
      audio.src = ''
    }
    audioRef.current = null
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [])

  const stop = useCallback(() => {
    genRef.current++ // invalidate any in-flight speak()
    teardown()
    setState('idle')
  }, [teardown])

  const speak = useCallback(
    async (text: string, opts?: { voice?: string; speed?: number }) => {
      // Supersede any prior playback/fetch; this call becomes the current one.
      genRef.current++
      const gen = genRef.current
      teardown()
      setState('loading')
      const controller = new AbortController()
      abortRef.current = controller

      // Create + play an <audio> for a media URL. Returns whether this call
      // still owns playback once play() resolved (false if superseded meanwhile).
      const startAudio = async (url: string): Promise<boolean> => {
        const audio = new Audio(url)
        audioRef.current = audio
        urlRef.current = url
        const finish = () => {
          if (gen === genRef.current) {
            teardown()
            setState('idle')
          }
        }
        audio.onended = finish
        // Any decode/stream error (e.g. a bad MSE chunk) fails quiet to idle.
        audio.onerror = finish
        await audio.play()
        if (gen !== genRef.current) {
          teardown()
          return false
        }
        return true
      }

      try {
        const res = await fetch('/api/voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            voice: opts?.voice,
            speed: opts?.speed
          }),
          signal: controller.signal
        })
        if (gen !== genRef.current) return // superseded while fetching
        if (!res.ok) {
          setState('idle')
          return
        }

        const canStream =
          typeof MediaSource !== 'undefined' &&
          MediaSource.isTypeSupported('audio/mpeg')

        if (canStream && res.body) {
          // Progressive: play from the first streamed bytes.
          const body = res.body
          const mediaSource = new MediaSource()
          const url = URL.createObjectURL(mediaSource)
          mediaSource.addEventListener(
            'sourceopen',
            () => {
              void pumpIntoSourceBuffer(mediaSource, body, controller.signal)
            },
            { once: true }
          )
          if (await startAudio(url)) setState('playing')
        } else {
          // Fallback: buffer the whole clip, then play.
          const url = URL.createObjectURL(await res.blob())
          if (gen !== genRef.current) {
            URL.revokeObjectURL(url)
            return
          }
          if (await startAudio(url)) setState('playing')
        }
      } catch {
        // Includes AbortError from a superseded fetch — only the still-current
        // call should reflect the failure in the UI.
        if (gen === genRef.current) setState('idle')
      }
    },
    [teardown]
  )

  // Stop playback (and cancel any fetch) when the consumer unmounts.
  useEffect(() => stop, [stop])

  return { speak, stop, state }
}
