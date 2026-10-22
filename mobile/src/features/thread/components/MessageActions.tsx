// The actions under an answer: copy it, share it with the native share sheet,
// read it aloud, retry the turn, and list its sources. Copy and Share use the
// same text as the web's Copy (citations as source links, spec fences gone);
// Share adds the cited URLs. In a saved chat, Share first asks whether to
// share the answer or a public link to the chat; the link is made with that
// choice open, and a failure to make it is said there. Read aloud is a
// speaker that turns into a spinner while the audio loads and a stop button
// while it plays; a tap on either stops.

import { Clipboard } from '@capacitor/clipboard'
import { Share } from '@capacitor/share'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { haptic } from '@/core/haptics'
import { Sheet } from '@/core/ui/Sheet'
import { SourcesSheet } from '@/features/thread/components/SourcesSheet'
import {
  copyableAnswer,
  type CitationMaps,
  type Source
} from '@/features/thread/model/citations'
import {
  COPIED_MS,
  isShareCancelled,
  SHARE_LINK_ERROR
} from '@/features/thread/share-api'
import { useMakeLink } from '@/features/thread/useMakeLink'
import type { ReadAloud } from '@/features/voice/useReadAloud'

export const COPY_ERROR = 'Couldn’t copy the answer.'
export const SHARE_ERROR = 'Couldn’t share the answer.'

/** A chat's public link, and the title it is shared under. */
export type ChatLink = { title: string; url: string }

export type MessageActionsProps = {
  /** The answer text as the model wrote it. */
  text: string
  maps: CitationMaps
  /** The user's question, the shared item's title. */
  question: string
  sources: Source[]
  onRetry: () => void
  /** This answer's read-aloud (its turn owns it, for auto-read). */
  readAloud: ReadAloud
  /**
   * Makes the chat's public link. Absent while the chat isn't saved, when
   * Share shares the answer at once.
   */
  linkToChat?: () => Promise<ChatLink>
}

const CHOICE =
  'min-h-12 touch-manipulation rounded-xl px-4 text-left text-base text-foreground active:bg-muted disabled:opacity-50'

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
  busy,
  children
}: {
  label: string
  onClick: () => void
  busy?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-busy={busy || undefined}
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
  retry: 'M4 4v6h6M20 12a8 8 0 1 1-2.34-5.66L20 8.5',
  speaker:
    'M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11'
}

function Spinner() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5 animate-spin"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
    >
      <path d="M12 3a9 9 0 0 1 9 9" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5">
      <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
    </svg>
  )
}

/** The read-aloud control, by its state. */
function ReadAloudButton({
  readAloud,
  text
}: {
  readAloud: ReadAloud
  text: string
}) {
  const onClick = () => readAloud.toggle(text)
  if (readAloud.state === 'loading') {
    return (
      <ActionButton label="Loading audio" onClick={onClick} busy>
        <Spinner />
      </ActionButton>
    )
  }
  if (readAloud.state === 'playing') {
    return (
      <ActionButton label="Stop reading" onClick={onClick}>
        <StopIcon />
      </ActionButton>
    )
  }
  return (
    <ActionButton label="Read aloud" onClick={onClick}>
      <Icon d={ICONS.speaker} />
    </ActionButton>
  )
}

export function MessageActions({
  text,
  maps,
  question,
  sources,
  onRetry,
  readAloud,
  linkToChat
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  // The share choice, and the link made while it is open.
  const [choosing, setChoosing] = useState(false)
  const link = useMakeLink()
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

  /** Opens the share sheet; a failure other than a cancel says `failure`. */
  const present = async (
    options: Parameters<typeof Share.share>[0],
    failure: string
  ) => {
    try {
      await Share.share(options)
    } catch (e) {
      if (!isShareCancelled(e)) setError(failure)
    }
  }

  const shareAnswer = () =>
    present(
      { title: question, text: shareText(text, maps, sources) },
      SHARE_ERROR
    )

  const closeChoice = () => {
    link.cancel()
    setChoosing(false)
  }

  const share = async () => {
    setError(null)
    if (!linkToChat) return shareAnswer()
    link.cancel()
    setChoosing(true)
  }

  const chooseAnswer = () => {
    closeChoice()
    return shareAnswer()
  }

  const chooseLink = async () => {
    const made = await link.run(linkToChat!)
    if (!made) return
    closeChoice()
    await present({ title: made.title, url: made.url }, SHARE_LINK_ERROR)
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
        {text.trim() && <ReadAloudButton readAloud={readAloud} text={text} />}
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
      {(error ?? readAloud.error) && (
        <p role="alert" className="pt-1 text-sm text-red-500">
          {error ?? readAloud.error}
        </p>
      )}
      <Sheet open={choosing} onClose={closeChoice} title="Share">
        <div className="flex flex-col gap-1 pb-2">
          <button
            type="button"
            disabled={link.making}
            onClick={() => void chooseAnswer()}
            className={CHOICE}
          >
            Share answer
          </button>
          <button
            type="button"
            aria-busy={link.making || undefined}
            disabled={link.making}
            onClick={() => void chooseLink()}
            className={CHOICE}
          >
            {link.making ? 'Creating link…' : 'Share link to chat'}
          </button>
          {link.error && (
            <p
              role="alert"
              className="px-4 pt-1 text-sm text-red-600 dark:text-red-400"
            >
              {link.error}
            </p>
          )}
        </div>
      </Sheet>
      <SourcesSheet
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
        sources={sources}
      />
    </div>
  )
}
