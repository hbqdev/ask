'use client'

import Link from 'next/link'

import { IconHistory } from '@tabler/icons-react'

import { cn } from '@/lib/utils'

// Mirrors the `recall` entry in UIDataTypes (lib/types/ai.ts) — the
// data-recall part streamed by create-chat-stream-response.ts when past
// conversation excerpts were injected into this turn.
export type RecallData = { chats: { chatId: string; title: string }[] }

export type RecallPart = {
  type: 'data-recall'
  id?: string
  data: RecallData
}

/**
 * Attribution for auto-injected recall: which past conversations shaped this
 * answer. Each chip navigates to that chat — recall stays inspectable rather
 * than spooky. Renders nothing when nothing was recalled.
 */
export function RecallSection({ data }: { data: RecallData }) {
  if (!data?.chats?.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <IconHistory size={14} className="shrink-0" />
      <span>Recalled from:</span>
      {data.chats.map(c => (
        <Link
          key={c.chatId}
          href={`/search/${c.chatId}`}
          className={cn(
            'max-w-[220px] truncate rounded-full border px-2 py-0.5',
            'hover:bg-muted transition-colors'
          )}
        >
          {c.title}
        </Link>
      ))}
    </div>
  )
}
