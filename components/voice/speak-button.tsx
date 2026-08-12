'use client'
import { useEffect } from 'react'

import { useSpeechPlayback } from '@/hooks/use-speech-playback'

// A "Listen" control shown on an answer. In voice mode (autoPlay) it plays the
// gist as soon as it arrives; otherwise it's a manual button. Renders nothing
// until there is a gist to speak.
export function SpeakButton({
  gistText,
  autoPlay
}: {
  gistText: string
  autoPlay: boolean
}) {
  const { speak, stop, state } = useSpeechPlayback()

  useEffect(() => {
    if (autoPlay && gistText) speak(gistText)
    return () => stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, gistText])

  if (!gistText) return null

  return (
    <button
      type="button"
      aria-label={state === 'playing' ? 'Stop' : 'Listen'}
      onClick={() => (state === 'playing' ? stop() : speak(gistText))}
      className="text-muted-foreground hover:text-foreground text-xs"
    >
      {state === 'playing' ? '■ Stop' : state === 'loading' ? '… Loading' : '▶ Listen'}
    </button>
  )
}
