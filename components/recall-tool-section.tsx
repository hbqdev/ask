'use client'

import Link from 'next/link'

import { IconHistory } from '@tabler/icons-react'

import { cn } from '@/lib/utils'

export interface RecallToolResult {
  results: {
    chatId: string
    chatTitle: string
    role: string
    date: string
    content: string
  }[]
}

interface RecallToolSectionProps {
  query?: string
  output?: RecallToolResult
  borderless?: boolean
  isFirst?: boolean
  isLast?: boolean
}

/**
 * The research-process step for a `recall` tool call: what the model looked
 * for in the user's history and what it found. Each hit links to its chat.
 *
 * Non-collapsible, like FetchSection — so it mirrors FetchSection's card
 * border / connector rail treatment rather than inventing its own: a
 * standalone card when singular (`!borderless`), or borderless with
 * top/bottom rails to connect it to its neighbours when grouped.
 */
export function RecallToolSection({
  query,
  output,
  borderless = false,
  isFirst = false,
  isLast = false
}: RecallToolSectionProps) {
  const results = output?.results ?? []
  return (
    <div className="relative">
      {/* Rails for header - show based on position */}
      {borderless && (
        <>
          {!isFirst && (
            <div className="absolute left-[19.5px] w-px bg-border h-2 top-0" />
          )}
          {!isLast && (
            <div className="absolute left-[19.5px] w-px bg-border h-2 bottom-0" />
          )}
        </>
      )}
      {/* Header + results - no collapsible body */}
      <div
        className={cn(
          'space-y-2 rounded-lg p-3 text-sm',
          !borderless && 'bg-card border border-border'
        )}
      >
        <div className="flex items-center gap-2 text-muted-foreground">
          <IconHistory size={16} className="shrink-0" />
          <span>
            Searched your past conversations
            {query ? ` for “${query}”` : ''} → {results.length}{' '}
            {results.length === 1 ? 'result' : 'results'}
          </span>
        </div>
        {results.map((r, i) => (
          <Link
            key={`${r.chatId}-${i}`}
            href={`/search/${r.chatId}`}
            className="block rounded-md border p-2 hover:bg-muted transition-colors"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium min-w-0">
                {r.chatTitle}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {r.date}
              </span>
            </div>
            {/* The recalled snippet text is intentionally NOT shown here: it
                still goes to the model (in the tool result) to answer with,
                but the process step surfaces only which past chats matched,
                not their raw content. */}
          </Link>
        ))}
      </div>
    </div>
  )
}
