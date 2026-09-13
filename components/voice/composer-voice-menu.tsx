'use client'

import { IconDots, IconVolume, IconVolumeOff } from '@tabler/icons-react'

import { cn } from '@/lib/utils'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover'

import { VoiceSettingsControls } from './voice-settings-popover'

interface ComposerVoiceMenuProps {
  voiceMode: boolean
  onVoiceModeChange?: (next: boolean) => void
}

// Mobile-only overflow menu for the composer's voice controls. On a phone the
// action row can't fit the read-aloud toggle + voice-settings picker inline
// without pushing the send button off the edge, so both live behind a single
// "⋯" button here. The mic (dictation) stays inline — its press-and-hold gesture
// doesn't belong in a popover. Desktop shows the controls inline instead.
export function ComposerVoiceMenu({
  voiceMode,
  onVoiceModeChange
}: ComposerVoiceMenuProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Voice controls"
          className="size-8 shrink-0 rounded-full text-muted-foreground"
        >
          <IconDots className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 space-y-3 p-3">
        <button
          type="button"
          aria-pressed={voiceMode}
          onClick={() => onVoiceModeChange?.(!voiceMode)}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted',
            voiceMode ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {voiceMode ? (
            <IconVolume className="size-4 shrink-0" />
          ) : (
            <IconVolumeOff className="size-4 shrink-0" />
          )}
          <span>Read answers aloud</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {voiceMode ? 'On' : 'Off'}
          </span>
        </button>
        <div className="h-px bg-border" />
        <VoiceSettingsControls />
      </PopoverContent>
    </Popover>
  )
}
