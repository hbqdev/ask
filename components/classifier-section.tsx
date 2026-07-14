'use client'

import { IconListSearch, IconMessageCircle } from '@tabler/icons-react'

import { cn } from '@/lib/utils'

// Mirrors the `classifier` entry in UIDataTypes (lib/types/ai.ts) — the
// data-classifier part streamed by create-chat-stream-response.ts while the
// query classifier decides whether this turn needs a fresh search.
export type ClassifierData =
  | { state: 'running' }
  | {
      state: 'done'
      skipSearch: boolean
      standaloneQuery?: string
      durationMs?: number
    }

export type ClassifierPart = {
  type: 'data-classifier'
  id?: string
  data: ClassifierData
}

/**
 * One row in the research-process step list for the query-classification
 * phase. Unlike tool sections there's nothing to expand — it's a status
 * line: pulsing while the classifier decides, then a static record of the
 * decision ("answering from conversation" vs the resolved search query).
 */
export function ClassifierSection({ part }: { part: ClassifierPart }) {
  const data = part.data
  const isRunning = !data || data.state === 'running'

  let label: string
  if (isRunning) {
    label = 'Deciding whether this needs a fresh search…'
  } else if (data.skipSearch) {
    label = 'No new search needed — answering from the conversation'
  } else if (data.standaloneQuery) {
    label = `Researching: ${data.standaloneQuery}`
  } else {
    label = 'Fresh search needed for this turn'
  }

  const Icon =
    isRunning || !('skipSearch' in data) || !data.skipSearch
      ? IconListSearch
      : IconMessageCircle

  return (
    <div className="flex items-center gap-2 w-full px-3 py-2 text-xs text-muted-foreground">
      <Icon className="size-4 shrink-0" />
      <span className={cn('truncate', isRunning && 'animate-pulse')}>
        {label}
      </span>
      {!isRunning && data.state === 'done' && data.durationMs != null && (
        <span className="shrink-0 ml-auto text-muted-foreground/70">
          {(data.durationMs / 1000).toFixed(1)}s
        </span>
      )}
    </div>
  )
}

export default ClassifierSection
