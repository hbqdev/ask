'use client'

import { IconChevronDown } from '@tabler/icons-react'

import {
  DEFAULT_TTS_SPEED,
  DEFAULT_TTS_VOICE,
  TTS_SPEEDS,
  TTS_VOICES
} from '@/lib/voice/voices'

import { useClientSettingValue } from '@/hooks/use-client-setting'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover'

function lsSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode — the choice just won't persist across sessions */
  }
  window.dispatchEvent(
    new CustomEvent('client-config-changed', { detail: key })
  )
}

// Compact voice + speed picker anchored to the voice toggle in the composer, so
// the read-aloud controls live right where voice is turned on. Reads/writes the
// same client settings the SpeakButton consumes (voiceTtsVoice/voiceTtsSpeed).
export function VoiceSettingsPopover() {
  const voice = useClientSettingValue('voiceTtsVoice', DEFAULT_TTS_VOICE)
  const speed = useClientSettingValue(
    'voiceTtsSpeed',
    String(DEFAULT_TTS_SPEED)
  )

  const selectClass =
    'w-full rounded-md border border-border bg-muted px-2 py-1.5 text-xs text-foreground focus:outline-none'

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Voice settings"
          title="Voice & speed"
          className="size-6 shrink-0 rounded-full text-muted-foreground"
        >
          <IconChevronDown className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 space-y-3 p-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Voice</span>
          <select
            value={voice}
            onChange={e => lsSet('voiceTtsVoice', e.target.value)}
            className={selectClass}
          >
            {TTS_VOICES.map(v => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Speed</span>
          <select
            value={speed}
            onChange={e => lsSet('voiceTtsSpeed', e.target.value)}
            className={selectClass}
          >
            {TTS_SPEEDS.map(s => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </PopoverContent>
    </Popover>
  )
}
