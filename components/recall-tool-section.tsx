'use client'

import Link from 'next/link'

import { IconHistory } from '@tabler/icons-react'

export interface RecallToolResult {
  results: {
    chatId: string
    chatTitle: string
    role: string
    date: string
    content: string
  }[]
}

/**
 * The research-process step for a `recall` tool call: what the model looked
 * for in the user's history and what it found. Each hit links to its chat.
 */
export function RecallToolSection({
  query,
  output
}: {
  query?: string
  output?: RecallToolResult
}) {
  const results = output?.results ?? []
  return (
    <div className="space-y-2 text-sm">
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
            <span className="truncate font-medium">{r.chatTitle}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {r.date}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {r.content}
          </p>
        </Link>
      ))}
    </div>
  )
}
