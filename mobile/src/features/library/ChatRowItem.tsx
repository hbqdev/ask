// One Library row: the chat's title, when, its search mode (when not the
// default) and its file count. A tap opens it; a swipe offers Delete and
// Rename.

import { memo } from 'react'

import { SwipeRow } from '@/core/ui/SwipeRow'
import { SEARCH_MODE_LABELS } from '@/features/compose/SearchOptionFields'
import type { ChatRow } from '@/features/library/library-api'
import { relativeTime } from '@/features/library/relative-time'

export type ChatRowItemProps = {
  chat: ChatRow
  /** The date the row shows (ISO): the one its section is grouped by. */
  time: string
  now: Date
  onOpen(chat: ChatRow): void
  onDelete(chat: ChatRow): void
  onRename(chat: ChatRow): void
}

// Off-screen rows skip layout and paint; this is the size they hold meanwhile.
const ROW_STYLE = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 72px'
} as const

/** Balanced is the default mode, so only the other two get a badge. */
function modeBadge(searchMode: string | undefined) {
  return searchMode === 'quality' || searchMode === 'speed'
    ? SEARCH_MODE_LABELS[searchMode]
    : undefined
}

function Paperclip() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" />
    </svg>
  )
}

/**
 * Memoized: a row renders again only when its own props change, so a long
 * list costs nothing to keep while the screen around it updates. Pass stable
 * callbacks and a `now` that changes once a day.
 */
export const ChatRowItem = memo(function ChatRowItem({
  chat,
  time,
  now,
  onOpen,
  onDelete,
  onRename
}: ChatRowItemProps) {
  const badge = modeBadge(chat.searchMode)
  const files = chat.fileCount
  return (
    <li style={ROW_STYLE} className="border-b border-border last:border-b-0">
      <SwipeRow
        actions={[
          {
            label: 'Delete',
            tone: 'destructive',
            onAction: () => onDelete(chat)
          },
          { label: 'Rename', onAction: () => onRename(chat) }
        ]}
        onPress={() => onOpen(chat)}
      >
        <div className="flex min-h-[72px] flex-col justify-center gap-1 px-4 py-3">
          <span className="line-clamp-2 text-base leading-snug font-medium">
            {chat.title || 'Untitled'}
          </span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <time dateTime={time}>{relativeTime(time, now)}</time>
            {badge && (
              <span className="rounded-full border border-border px-2 py-0.5">
                {badge}
              </span>
            )}
            {files > 0 && (
              <span
                data-testid="files-badge"
                className="inline-flex items-center gap-0.5"
              >
                <Paperclip />
                {files}
                <span className="sr-only">
                  {files === 1 ? ' file' : ' files'}
                </span>
              </span>
            )}
          </span>
        </div>
      </SwipeRow>
    </li>
  )
})
