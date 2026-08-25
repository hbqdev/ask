'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

type PlaybackState = 'idle' | 'loading' | 'playing'

// Fetches TTS audio for a gist and plays it. Fail-quiet: any error returns to
// idle without throwing, so a TTS outage never breaks the UI.
//
// SINGLE-FLIGHT: only ever one playback at a time. Each speak()/stop() bumps a
// generation counter and aborts the prior request; any async continuation from
// a superseded call (its fetch, blob read, or play()) checks the generation and
// bails without creating or playing audio. Without this, a repeated trigger
// (e.g. the auto-play effect firing more than once) stacked concurrent fetches
// whose audio all played at once — several voices reading the same answer over
// each other, each from the top.
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
    async (text: string) => {
      // Supersede any prior playback/fetch; this call becomes the current one.
      genRef.current++
      const gen = genRef.current
      teardown()
      setState('loading')
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const res = await fetch('/api/voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: controller.signal
        })
        if (gen !== genRef.current) return // superseded while fetching
        if (!res.ok) {
          setState('idle')
          return
        }
        const blob = await res.blob()
        if (gen !== genRef.current) return // superseded while reading the body
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        audioRef.current = audio
        urlRef.current = url
        audio.onended = () => {
          if (gen === genRef.current) {
            teardown()
            setState('idle')
          }
        }
        await audio.play()
        if (gen !== genRef.current) {
          // stop()/another speak() won while play() was resolving.
          teardown()
          return
        }
        setState('playing')
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
