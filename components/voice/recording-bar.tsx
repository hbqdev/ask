'use client'
import { useEffect, useState } from 'react'

import {
  IconArrowUp as ArrowUp,
  IconLoader2 as Loader,
  IconX as X
} from '@tabler/icons-react'

import { Button } from '../ui/button'

import { WaveformVisualizer } from './waveform-visualizer'

// The inline recording UI shown inside the composer while dictating: a pulsing
// red dot, "Listening…", a running timer, a live waveform, and cancel/stop
// controls. Switches to a "Transcribing…" spinner once recording stops.
export function RecordingBar({
  stream,
  state,
  onStop,
  onCancel
}: {
  stream: MediaStream | null
  state: 'recording' | 'transcribing'
  onStop: () => void
  onCancel: () => void
}) {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    if (state !== 'recording') return
    const id = setInterval(() => setSeconds(s => s + 1), 1000)
    return () => clearInterval(id)
  }, [state])

  if (state === 'transcribing') {
    return (
      <div className="flex h-full items-center gap-2 px-4">
        <Loader className="size-4 shrink-0 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Transcribing…</span>
      </div>
    )
  }

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

  return (
    <div className="flex h-full items-center gap-3 px-3 md:px-4">
      <span className="relative flex size-2.5 shrink-0" aria-hidden>
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-75" />
        <span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
      </span>
      <span className="shrink-0 text-sm font-medium text-foreground">
        Listening…
      </span>
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {mmss}
      </span>
      <WaveformVisualizer
        stream={stream}
        className="min-w-0 flex-1 text-red-500/80"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Cancel recording"
        onClick={onCancel}
        className="size-8 shrink-0 rounded-full text-muted-foreground"
      >
        <X className="size-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        aria-label="Stop and send"
        onClick={onStop}
        className="size-8 shrink-0 rounded-full"
      >
        <ArrowUp className="size-4" />
      </Button>
    </div>
  )
}
