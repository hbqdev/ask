// Every source behind an answer, in a sheet: the cited ones first, each row
// opening its page in the in-app browser.

import { Sheet } from '@/core/ui/Sheet'
import { SourceIcon } from '@/features/thread/components/CitationChip'
import { openLink } from '@/features/thread/components/open-link'
import type { Source } from '@/features/thread/model/citations'
import { snippetText } from '@/lib/utils/snippet-text'

export type SourcesSheetProps = {
  open: boolean
  onClose: () => void
  sources: Source[]
}

export function SourcesSheet({ open, onClose, sources }: SourcesSheetProps) {
  const ordered = [
    ...sources.filter(s => s.cited),
    ...sources.filter(s => !s.cited)
  ]
  return (
    <Sheet open={open} onClose={onClose} title="Sources">
      <ul className="flex flex-col pb-2">
        {ordered.map(source => (
          <li key={source.url}>
            <button
              type="button"
              onClick={() => openLink(source.url)}
              className="flex min-h-11 w-full touch-manipulation items-start gap-3 rounded-xl px-2 py-2.5 text-left active:bg-foreground/5"
            >
              <SourceIcon source={source} className="mt-0.5 size-5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 block text-sm font-medium">
                  {snippetText(source.title) || source.host}
                </span>
                <span className="block truncate text-xs text-foreground/50">
                  {source.host}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}
