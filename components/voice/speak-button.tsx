'use client'
import { useEffect, useRef } from 'react'

import {
  IconLoader2,
  IconPlayerStopFilled,
  IconVolume
} from '@tabler/icons-react'

import { DEFAULT_TTS_SPEED, DEFAULT_TTS_VOICE } from '@/lib/voice/voices'

import { useClientSettingValue } from '@/hooks/use-client-setting'
import { useSpeechPlayback } from '@/hooks/use-speech-playback'

import { Button } from '@/components/ui/button'

// A "Listen" control for an answer, styled to sit inline with the other answer
// actions (copy/share/…). In voice mode (autoPlay) it reads the answer as soon
// as it arrives; the manual click re-reads it. Renders nothing without a gist.
export function SpeakButton({
  gistText,
  autoPlay
}: {
  gistText: string
  autoPlay: boolean
}) {
  const { speak, stop, state } = useSpeechPlayback()

  // Per-user read-aloud voice + speed (from Settings/the voice popover).
  const voice = useClientSettingValue('voiceTtsVoice', DEFAULT_TTS_VOICE)
  const speedStr = useClientSettingValue(
    'voiceTtsSpeed',
    String(DEFAULT_TTS_SPEED)
  )
  const speed = Number(speedStr) || DEFAULT_TTS_SPEED

  // Auto-play a given gist at most once. Without this, any re-run of the effect
  // with the same answer (a re-render/re-mount while it's still the latest
  // message) would restart the read-aloud from the top.
  const autoSpokenRef = useRef<string | null>(null)

  useEffect(() => {
    if (autoPlay && gistText && autoSpokenRef.current !== gistText) {
      autoSpokenRef.current = gistText
      speak(gistText, { voice, speed })
    }
    return () => stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, gistText])

  if (!gistText) return null

  const playing = state === 'playing'
  const loading = state === 'loading'
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => (playing ? stop() : speak(gistText, { voice, speed }))}
      className="rounded-full"
      aria-label={playing ? 'Stop reading aloud' : 'Listen to this answer'}
      title={playing ? 'Stop' : loading ? 'Loading…' : 'Listen'}
    >
      {loading ? (
        <IconLoader2 size={14} className="animate-spin" />
      ) : playing ? (
        <IconPlayerStopFilled size={14} />
      ) : (
        <IconVolume size={14} />
      )}
    </Button>
  )
}
