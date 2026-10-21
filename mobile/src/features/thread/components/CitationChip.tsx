// A cited source inline in the answer: a pill with the site's favicon and
// host. A tap previews the source in a sheet (touch has no hover), and the
// preview's Open button shows the page in the in-app browser.

import { useState } from 'react'

import { Sheet } from '@/core/ui/Sheet'
import { openLink } from '@/features/thread/components/open-link'
import type { Source } from '@/features/thread/model/citations'
import { snippetText } from '@/lib/utils/snippet-text'

/** The site's favicon, or its initial when the icon can't be loaded. */
export function SourceIcon({
  source,
  className
}: {
  source: Source
  className: string
}) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span
        aria-hidden="true"
        className={`${className} inline-flex items-center justify-center rounded-full bg-foreground/10 text-[0.6rem] font-semibold`}
      >
        {source.host.charAt(0).toUpperCase()}
      </span>
    )
  }
  return (
    <img
      src={source.favicon}
      alt=""
      className={`${className} rounded-full`}
      onError={() => setFailed(true)}
    />
  )
}

export function CitationChip({ source }: { source: Source }) {
  const [open, setOpen] = useState(false)
  const title = snippetText(source.title) || source.host
  const snippet = snippetText(source.snippet)

  return (
    <>
      <button
        type="button"
        data-citation={source.url}
        onClick={() => setOpen(true)}
        className="citation-chip mx-0.5 inline-flex h-5 max-w-[10rem] touch-manipulation items-center gap-1 rounded-full bg-foreground/8 px-1.5 text-[0.7rem] leading-none font-medium text-foreground/70 active:opacity-50"
      >
        <SourceIcon source={source} className="size-3 shrink-0" />
        <span className="truncate">{source.host}</span>
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={title}>
        <div className="flex flex-col gap-3 px-2 pb-2">
          <div className="flex items-center gap-2 text-sm text-foreground/60">
            <SourceIcon source={source} className="size-4 shrink-0" />
            <span className="truncate">{source.host}</span>
          </div>
          {snippet && (
            <p className="text-sm leading-relaxed text-foreground/80">
              {snippet}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              openLink(source.url)
            }}
            className="min-h-11 touch-manipulation rounded-xl bg-foreground text-sm font-medium text-background active:opacity-50"
          >
            Open
          </button>
        </div>
      </Sheet>
    </>
  )
}
