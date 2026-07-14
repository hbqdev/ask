'use client'

import { IconPaperclip } from '@tabler/icons-react'

import { cn } from '@/lib/utils'

// Mirrors the `attachments` entry in UIDataTypes (lib/types/ai.ts) — the
// data-attachments part streamed by create-chat-stream-response.ts while
// uploaded files are prepared for the model (PDF RAG/extraction, image
// encoding). Re-runs on every turn of a chat that contains attachments.
export type AttachmentsData =
  | { state: 'running'; count: number }
  | { state: 'done'; count: number; durationMs?: number }

export type AttachmentsPart = {
  type: 'data-attachments'
  id?: string
  data: AttachmentsData
}

/**
 * One row in the research-process step list for attachment preparation.
 * Like ClassifierSection it's a plain status line: pulsing while files are
 * being processed, then a static record once done.
 */
export function AttachmentsSection({ part }: { part: AttachmentsPart }) {
  const data = part.data
  const isRunning = !data || data.state === 'running'
  const count = data?.count ?? 1
  const noun = count === 1 ? 'attachment' : 'attachments'

  const label = isRunning
    ? `Processing ${count} ${noun}…`
    : `Processed ${count} ${noun}`

  return (
    <div className="flex items-center gap-2 w-full px-3 py-2 text-xs text-muted-foreground">
      <IconPaperclip className="size-4 shrink-0" />
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

export default AttachmentsSection
