'use client'
import { useCallback, useRef, useState } from 'react'

type PlaybackState = 'idle' | 'loading' | 'playing'

// Fetches TTS audio for a gist and plays it. Fail-quiet: any error returns to
// idle without throwing, so a TTS outage never breaks the UI.
export function useSpeechPlayback() {
  const [state, setState] = useState<PlaybackState>('idle')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // Resolver for the in-flight speak() promise. speak() resolves only when
  // playback COMPLETES (ended/error) so the hands-free loop can wait for the
  // reply to finish before re-arming the mic. Pausing does not fire `onended`,
  // so stop() settles the pending promise through this ref.
  const resolveRef = useRef<(() => void) | null>(null)

  const stop = useCallback(() => {
    audioRef.current?.pause()
    if (audioRef.current) audioRef.current.src = ''
    resolveRef.current?.()
    resolveRef.current = null
    setState('idle')
  }, [])

  const speak = useCallback(
    async (text: string) => {
      try {
        stop()
        setState('loading')
        const res = await fetch('/api/voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        })
        if (!res.ok) {
          setState('idle')
          return
        }
        const url = URL.createObjectURL(await res.blob())
        const audio = new Audio(url)
        audioRef.current = audio
        // Resolve only once playback finishes (or errors, or stop() cuts it).
        await new Promise<void>(resolve => {
          const settle = () => {
            resolveRef.current = null
            resolve()
          }
          resolveRef.current = settle
          audio.onended = () => {
            setState('idle')
            settle()
          }
          audio.onerror = () => {
            setState('idle')
            settle()
          }
          audio
            .play()
            .then(() => setState('playing'))
            .catch(() => {
              setState('idle')
              settle()
            })
        })
      } catch {
        setState('idle')
      }
    },
    [stop]
  )

  return { speak, stop, state }
}
