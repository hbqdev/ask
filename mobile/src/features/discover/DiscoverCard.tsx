// Discover's stories: the large lead card at the top of the feed and the
// compact rows under it. A tap on the story opens the article; its own
// Summarize button asks Ask for a summary instead. Both are memoized, so a
// feed render (a page landing, a pull) only renders stories that changed.

import { memo, useId, useState } from 'react'

import { SEPARATOR } from '@/core/ui/classes'
import type { DiscoverItem } from '@/features/discover/discover-api'

export type DiscoverCardProps = {
  item: DiscoverItem
  /** Opens the article (its url). */
  onOpen(url: string): void
  /** Asks for a summary of the article (its url). */
  onSummarize(url: string): void
}

/**
 * A story's thumbnail in a box of fixed size (`className`), so the feed never
 * shifts as images load. A failed image becomes a neutral placeholder rather
 * than the broken-image icon; a different thumbnail is tried afresh.
 */
function Thumb({ src, className }: { src: string; className: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  return (
    <div
      data-testid="discover-thumb"
      className={`shrink-0 overflow-hidden bg-muted ${className}`}
    >
      {failedSrc === src ? (
        <div
          data-testid="discover-thumb-placeholder"
          aria-hidden="true"
          className="flex size-full items-center justify-center text-foreground/20"
        >
          <svg
            viewBox="0 0 24 24"
            className="size-1/3 max-h-10 max-w-10"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="m3 16 5-5 4 4 3-3 6 6" />
          </svg>
        </div>
      ) : (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailedSrc(src)}
          className="size-full object-cover"
        />
      )}
    </div>
  )
}

function SparkleIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M6.3 17.7l2.1-2.1M15.6 8.4l2.1-2.1" />
    </svg>
  )
}

/** The feed's first story: a 16:9 image (at most 360 px tall), the title and the summary. */
export const DiscoverLeadCard = memo(function DiscoverLeadCard({
  item,
  onOpen,
  onSummarize
}: DiscoverCardProps) {
  const id = useId()
  return (
    <article
      data-testid="discover-lead"
      className="mx-4 mb-2 overflow-hidden rounded-2xl bg-muted"
    >
      <button
        type="button"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-summary`}
        onClick={() => onOpen(item.url)}
        className="block w-full touch-manipulation text-left active:opacity-70"
      >
        {/* 16:9, capped on an iPad's wide column (the image crops to fill). */}
        <Thumb
          src={item.thumbnail}
          className="aspect-video max-h-[360px] w-full"
        />
        <div className="flex flex-col gap-1.5 px-4 pt-3">
          <h2
            id={`${id}-title`}
            className="line-clamp-3 text-lg leading-snug font-semibold"
          >
            {item.title}
          </h2>
          <p
            id={`${id}-summary`}
            className="line-clamp-3 text-sm text-muted-foreground"
          >
            {item.summary}
          </p>
        </div>
      </button>
      <div className="flex px-2 pb-2">
        <button
          type="button"
          aria-label={`Summarize ${item.title}`}
          onClick={() => onSummarize(item.url)}
          className="inline-flex min-h-11 touch-manipulation items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-accent active:opacity-50"
        >
          <SparkleIcon />
          Summarize
        </button>
      </div>
    </article>
  )
})

/** A story after the first: a thumbnail and the title. */
export const DiscoverRow = memo(function DiscoverRow({
  item,
  onOpen,
  onSummarize,
  separator = false
}: DiscoverCardProps & {
  /** Draws an inset hairline under the row (all but the list's last). */
  separator?: boolean
}) {
  return (
    <li
      className={`flex items-center ${separator ? `relative ${SEPARATOR}` : ''}`}
    >
      <button
        type="button"
        onClick={() => onOpen(item.url)}
        className="flex min-h-[88px] min-w-0 flex-1 touch-manipulation items-center gap-3 py-3 pl-4 text-left active:bg-muted"
      >
        <Thumb src={item.thumbnail} className="h-16 w-24 rounded-lg" />
        <span className="line-clamp-3 min-w-0 flex-1 text-[0.9375rem] leading-snug font-medium">
          {item.title}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Summarize ${item.title}`}
        onClick={() => onSummarize(item.url)}
        className="mr-2 flex size-11 shrink-0 touch-manipulation items-center justify-center rounded-full text-accent active:bg-muted"
      >
        <SparkleIcon />
      </button>
    </li>
  )
})
