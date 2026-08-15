'use client'
import { IconMicrophone as Microphone } from '@tabler/icons-react'

import { Button } from '../ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '../ui/tooltip'

// Click-to-dictate trigger. Clicking starts a recording; the composer then
// swaps in the RecordingBar (live waveform + stop/cancel). The recording state
// and controls live in the parent, so this stays a dumb button.
export function MicButton({
  onStart,
  disabled
}: {
  onStart: () => void
  disabled?: boolean
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Dictate"
            disabled={disabled}
            onClick={() => onStart()}
            className="size-8 shrink-0 rounded-full text-muted-foreground"
          >
            <Microphone className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent className="text-xs">Dictate</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
