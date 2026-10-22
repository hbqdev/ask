// A question as the thread shows it, after the web's user turn
// (components/render-message.tsx): the photos in a grid that opens a full-size
// viewer, the other files as chips that open in the in-app browser, the text
// in a bubble, then pasted or quoted content (collapsed) and pasted links.
// Only an http(s) URL, or a relative /uploads one under the API base, is ever
// loaded or opened; anything else shows as a chip that does nothing.

import type { UIMessage } from 'ai'
import { useId, useLayoutEffect, useRef, useState } from 'react'

import { Sheet } from '@/core/ui/Sheet'
import { openLink } from '@/features/thread/components/open-link'

type Part = UIMessage['parts'][number]

/** At most this many photos show in the bubble; the last counts the rest. */
const GRID_MAX = 4

type Photo = { name: string; src: string }
type FileItem = { name: string; type: string; href: string | null }
type Quote = { label: string; text: string }
type Source = { url: string; href: string | null }

/**
 * The URL to load or open for an attachment: an http(s) URL as it is, a
 * relative upload under the API base, or null for anything else.
 */
export function attachmentUrl(url: string, baseUrl: string): string | null {
  if (url.startsWith('/uploads/')) return `${baseUrl.replace(/\/+$/, '')}${url}`
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** A file's type for its chip: its extension, else its media subtype. */
export function fileTypeLabel(filename: string, mediaType: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot > 0 && dot < filename.length - 1) {
    return filename.slice(dot + 1).toUpperCase()
  }
  const subtype = mediaType.split('/')[1]
  return subtype ? subtype.toUpperCase() : 'File'
}

function readParts(parts: Part[], baseUrl: string) {
  let text = ''
  const photos: Photo[] = []
  const files: FileItem[] = []
  const quotes: Quote[] = []
  const sources: Source[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      text += part.text
    } else if (part.type === 'file') {
      const href = attachmentUrl(part.url, baseUrl)
      if (href && part.mediaType.startsWith('image/')) {
        photos.push({ name: part.filename || 'Image', src: href })
      } else {
        files.push({
          name: part.filename || 'File',
          type: fileTypeLabel(part.filename ?? '', part.mediaType),
          href
        })
      }
    } else if (
      part.type === 'data-pastedContent' ||
      part.type === 'data-quotedContext'
    ) {
      const quoted = (part.data as { text?: string } | undefined)?.text
      if (quoted) {
        quotes.push({
          label:
            part.type === 'data-pastedContent'
              ? 'Pasted content'
              : 'Quoted context',
          text: quoted
        })
      }
    } else if (part.type === 'data-sourceUrl') {
      const url = (part.data as { url?: string } | undefined)?.url
      if (url) sources.push({ url, href: attachmentUrl(url, baseUrl) })
    }
  }
  return { text: text.trim() ? text : '', photos, files, quotes, sources }
}

function Icon({ d, className = 'size-5' }: { d: string; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
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

const FILE_ICON =
  'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5'
const PHOTO_ICON = 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5a1 1 0 1 0 0-.01'
const LINK_ICON =
  'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1'
const QUOTE_ICON = 'M8 6h11M8 12h11M8 18h7M4 6v12'
const CLOSE_ICON = 'M6 6l12 12M18 6L6 18'
const CHEVRON_ICON = 'M6 9l6 6 6-6'

/** A photo that shows a placeholder, not a broken image, when it fails. */
function Picture({ photo, className }: { photo: Photo; className: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div
        data-testid="image-placeholder"
        className="flex size-full items-center justify-center text-foreground/40"
      >
        <Icon d={PHOTO_ICON} className="size-8" />
      </div>
    )
  }
  return (
    <img
      src={photo.src}
      alt={photo.name}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={className}
    />
  )
}

function PhotoGrid({
  photos,
  onOpen
}: {
  photos: Photo[]
  onOpen: (index: number) => void
}) {
  const shown = photos.slice(0, GRID_MAX)
  const more = photos.length - shown.length
  const single = shown.length === 1
  return (
    <div
      data-testid="image-grid"
      data-count={shown.length}
      className={`w-64 max-w-full ${single ? '' : 'grid grid-cols-2 gap-1'}`}
    >
      {shown.map((photo, i) => (
        <button
          key={i}
          type="button"
          aria-label={`View ${photo.name}`}
          onClick={() => onOpen(i)}
          className={`relative block w-full touch-manipulation overflow-hidden bg-foreground/8 active:opacity-70 ${
            single
              ? 'aspect-[4/3] max-h-60 rounded-2xl'
              : 'aspect-square rounded-xl'
          }`}
        >
          <Picture photo={photo} className="size-full object-cover" />
          {i === GRID_MAX - 1 && more > 0 && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-xl font-semibold text-white">
              +{more}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

/** The photos full size, one per page, swiped sideways from `start`. */
function PhotoViewer({
  photos,
  start,
  onClose
}: {
  photos: Photo[]
  start: number
  onClose: () => void
}) {
  const [index, setIndex] = useState(start)
  const strip = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = strip.current!
    el.scrollLeft = start * el.clientWidth
  }, [start])

  const onScroll = () => {
    const el = strip.current!
    const page = Math.round(el.scrollLeft / Math.max(1, el.clientWidth))
    setIndex(Math.min(photos.length - 1, Math.max(0, page)))
  }

  const title =
    photos.length > 1 ? `Image ${index + 1} of ${photos.length}` : 'Image'
  return (
    <Sheet open onClose={onClose} title={title}>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute top-2 right-3 flex size-11 touch-manipulation items-center justify-center rounded-full text-foreground/70 active:bg-foreground/10"
      >
        <Icon d={CLOSE_ICON} className="size-6" />
      </button>
      <div
        ref={strip}
        data-testid="viewer-strip"
        onScroll={onScroll}
        className="-mx-4 flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain pb-6"
      >
        {photos.map((photo, i) => (
          <div
            key={i}
            className="flex h-[70vh] w-full shrink-0 snap-center items-center justify-center px-4"
          >
            <Picture
              photo={photo}
              className="max-h-full max-w-full rounded-xl object-contain"
            />
          </div>
        ))}
      </div>
    </Sheet>
  )
}

function FileChip({ file }: { file: FileItem }) {
  const body = (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-foreground/10 text-foreground/60">
        <Icon d={FILE_ICON} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm leading-5 font-medium">
          {file.name}
        </span>
        <span className="block text-xs leading-4 text-foreground/50">
          {file.type}
        </span>
      </span>
    </>
  )
  const look =
    'flex max-w-full items-center gap-2 rounded-2xl bg-foreground/8 p-1.5 pr-3 text-left'
  if (!file.href) return <div className={look}>{body}</div>
  const href = file.href
  return (
    <button
      type="button"
      aria-label={`Open ${file.name}`}
      onClick={() => openLink(href)}
      className={`${look} touch-manipulation active:opacity-60`}
    >
      {body}
    </button>
  )
}

function SourceChip({ source }: { source: Source }) {
  const look =
    'flex max-w-full items-center gap-1.5 rounded-full border border-foreground/15 py-1.5 pr-3 pl-2.5 text-sm text-foreground/70'
  if (!source.href) {
    return <span className={`${look} break-all`}>{source.url}</span>
  }
  const href = source.href
  const host = new URL(href).hostname.replace(/^www\./, '')
  return (
    <button
      type="button"
      aria-label={`Open ${href}`}
      onClick={() => openLink(href)}
      className={`${look} touch-manipulation active:opacity-60`}
    >
      <Icon d={LINK_ICON} className="size-4 shrink-0" />
      <span className="truncate">{host}</span>
    </button>
  )
}

function QuoteBlock({ quote }: { quote: Quote }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="flex max-w-full flex-col items-end">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        className="flex min-h-9 touch-manipulation items-center gap-1.5 rounded-xl px-2 text-xs font-medium text-foreground/60 active:bg-foreground/10"
      >
        <Icon d={QUOTE_ICON} className="size-4 shrink-0" />
        {quote.label} · {quote.text.length.toLocaleString()} chars
        <Icon
          d={CHEVRON_ICON}
          className={`size-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <blockquote
          id={id}
          className="mt-1 max-h-60 overflow-auto border-l-2 border-foreground/20 pl-3 text-sm break-words whitespace-pre-wrap text-foreground/70"
        >
          {quote.text}
        </blockquote>
      )}
    </div>
  )
}

export type UserMessageProps = {
  message: UIMessage
  /** The API base: a relative upload URL is under it. */
  baseUrl: string
}

export function UserMessage({ message, baseUrl }: UserMessageProps) {
  const [viewing, setViewing] = useState<number | null>(null)
  const { text, photos, files, quotes, sources } = readParts(
    message.parts,
    baseUrl
  )
  if (
    !text &&
    photos.length + files.length + quotes.length + sources.length === 0
  ) {
    return null
  }

  return (
    <div className="ml-auto flex max-w-[85%] flex-col items-end gap-2">
      {photos.length > 0 && <PhotoGrid photos={photos} onOpen={setViewing} />}
      {files.map((file, i) => (
        <FileChip key={i} file={file} />
      ))}
      {text && (
        <p
          data-testid="user-bubble"
          className="rounded-3xl bg-foreground/8 px-4 py-2.5 text-base whitespace-pre-wrap"
        >
          {text}
        </p>
      )}
      {quotes.map((quote, i) => (
        <QuoteBlock key={i} quote={quote} />
      ))}
      {sources.length > 0 && (
        <div className="flex max-w-full flex-wrap justify-end gap-1.5">
          {sources.map((source, i) => (
            <SourceChip key={i} source={source} />
          ))}
        </div>
      )}
      {viewing !== null && (
        <PhotoViewer
          photos={photos}
          start={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}
