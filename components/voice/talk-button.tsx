'use client'
import { IconHeadphones as Headphones } from '@tabler/icons-react'

import { Button } from '../ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '../ui/tooltip'

// Entry point for the hands-free voice loop. A tap opens the full-screen
// VoiceConversation overlay (mounted by the parent); this stays a dumb button.
export function TalkButton({
  onClick,
  disabled
}: {
  onClick: () => void
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
            aria-label="Talk (hands-free conversation)"
            disabled={disabled}
            onClick={onClick}
            className="size-8 shrink-0 rounded-full text-muted-foreground"
          >
            <Headphones className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent className="text-xs">Talk hands-free</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
