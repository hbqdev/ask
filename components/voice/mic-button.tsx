'use client'
import { IconMicrophone as Microphone } from '@tabler/icons-react'

import { Button } from '../ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '../ui/tooltip'

// Tap-or-hold dictate trigger. Recording starts on press (pointerdown) so a
// press-and-hold goes live immediately; the parent times the gesture to tell a
// quick tap (click-to-toggle, stopped via RecordingBar) from a hold (push-to-talk,
// stopped on release). onClick is the keyboard path (Enter/Space fire a click but
// no pointerdown); for a mouse, pointerdown starts recording and the trailing
// click is a harmless no-op (the hook's double-start guard). Once recording
// starts, the composer swaps in the RecordingBar. This stays a dumb button — all
// gesture timing lives in the parent.
export function MicButton({
  onPressStart,
  disabled
}: {
  onPressStart: () => void
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
            aria-label="Dictate (tap or hold)"
            disabled={disabled}
            onPointerDown={() => onPressStart()}
            onClick={() => onPressStart()}
            className="size-8 shrink-0 rounded-full text-muted-foreground"
          >
            <Microphone className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent className="text-xs">Tap or hold to talk</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
