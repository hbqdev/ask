'use client'
import {
  IconLoader2 as Loader,
  IconMicrophone as Microphone
} from '@tabler/icons-react'

import { cn } from '@/lib/utils'

import { useVoiceDictation } from '@/hooks/use-voice-dictation'

import { Button } from '../ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '../ui/tooltip'

// Push-to-talk mic for dictation. Hold to record, release to transcribe; the
// transcript is handed to onTranscript (the composer drops it into the input).
export function MicButton({
  onTranscript,
  disabled
}: {
  onTranscript: (text: string) => void
  disabled?: boolean
}) {
  const { state, start, stop } = useVoiceDictation(onTranscript)
  const recording = state === 'recording'
  const busy = state === 'transcribing'

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={recording ? 'Stop recording' : 'Dictate'}
            aria-pressed={recording}
            disabled={disabled || busy}
            onPointerDown={() => {
              if (!busy) void start()
            }}
            onPointerUp={() => {
              if (recording) stop()
            }}
            onPointerLeave={() => {
              if (recording) stop()
            }}
            className={cn(
              'size-8 shrink-0 rounded-full',
              recording ? 'text-red-500' : 'text-muted-foreground'
            )}
          >
            {busy ? (
              <Loader className="size-4 animate-spin" />
            ) : (
              <Microphone className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent className="text-xs">
          {busy ? 'Transcribing…' : 'Hold to dictate'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
