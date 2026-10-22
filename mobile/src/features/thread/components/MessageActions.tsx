// The actions under an answer: copy it, share it with the native share sheet,
// retry the turn, and list its sources. Copy and Share use the same text as
// the web's Copy (citations as source links, spec fences gone); Share adds
// the cited URLs.

import { Clipboard } from '@capacitor/clipboard'
import { Share } from '@capacitor/share'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { haptic } from '@/core/haptics'
import { SourcesSheet } from '@/features/thread/components/SourcesSheet'
import {
  copyableAnswer,
  type CitationMaps,
  type Source
} from '@/features/thread/model/citations'

/** How long Copy reads "Copied" after a copy. */
export const COPIED_MS = 1500
export const COPY_ERROR = 'Couldn’t copy the answer.'
export const SHARE_ERROR = 'Couldn’t share the answer.'

/** The share sheet rejects with "Share canceled" when the user dismisses it. */
const CANCELLED_RE = /cancel/i

export type MessageActionsProps = {
  /** The answer text as the model wrote it. */
  text: string
  maps: CitationMaps
  /** The user's question, the shared item's title. */
  question: string
  sources: Source[]
  onRetry: () => void
}

/** The answer as shared: the copied text, then the cited URLs, if any. */
function shareText(text: string, maps: CitationMaps, sources: Source[]) {
  const answer = copyableAnswer(text, maps)
  const cited = sources.filter(s => s.cited).map(s => s.url)
  return cited.length > 0
    ? `${answer}\n\nSources:\n${cited.join('\n')}`
    : answer
}

function ActionButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex min-h-11 min-w-11 touch-manipulation items-center justify-center gap-1.5 rounded-full px-2 text-sm text-foreground/60 active:opacity-50"
    >
      {children}
    </button>
  )
}

function Icon({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  )
}

const ICONS = {
  copy: 'M9 9h10v10H9zM5 15V5h10',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  share: 'M12 3v12M7 8l5-5 5 5M5 13v6h14v-6',
  retry: 'M4 4v6h6M20 12a8 8 0 1 1-2.34-5.66L20 8.5'
}

export function MessageActions({
  text,
  maps,
  question,
  sources,
  onRetry
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )

  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const copy = async () => {
    setError(null)
    try {
      await Clipboard.write({ string: copyableAnswer(text, maps) })
    } catch {
      setError(COPY_ERROR)
      return
    }
    haptic('success')
    setCopied(true)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }

  const share = async () => {
    setError(null)
    try {
      await Share.share({
        title: question,
        text: shareText(text, maps, sources)
      })
    } catch (e) {
      if (!CANCELLED_RE.test(e instanceof Error ? e.message : String(e))) {
        setError(SHARE_ERROR)
      }
    }
  }

  return (
    <div>
      <div className="-ml-2 flex items-center gap-1">
        <ActionButton label={copied ? 'Copied' : 'Copy'} onClick={copy}>
          <Icon d={copied ? ICONS.check : ICONS.copy} />
        </ActionButton>
        <ActionButton label="Share" onClick={share}>
          <Icon d={ICONS.share} />
        </ActionButton>
        <ActionButton label="Retry" onClick={onRetry}>
          <Icon d={ICONS.retry} />
        </ActionButton>
        {sources.length > 0 && (
          <ActionButton
            label={`Sources (${sources.length})`}
            onClick={() => setSourcesOpen(true)}
          >
            <span>Sources ({sources.length})</span>
          </ActionButton>
        )}
      </div>
      {error && (
        <p role="alert" className="pt-1 text-sm text-red-500">
          {error}
        </p>
      )}
      <SourcesSheet
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
        sources={sources}
      />
    </div>
  )
}
