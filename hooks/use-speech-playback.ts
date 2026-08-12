'use client'
import { useCallback, useRef, useState } from 'react'

type PlaybackState = 'idle' | 'loading' | 'playing'

// Fetches TTS audio for a gist and plays it. Fail-quiet: any error returns to
// idle without throwing, so a TTS outage never breaks the UI.
export function useSpeechPlayback() {
  const [state, setState] = useState<PlaybackState>('idle')
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const stop = useCallback(() => {
    audioRef.current?.pause()
    if (audioRef.current) audioRef.current.src = ''
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
        audio.onended = () => setState('idle')
        await audio.play()
        setState('playing')
      } catch {
        setState('idle')
      }
    },
    [stop]
  )

  return { speak, stop, state }
}
