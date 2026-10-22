// A question as the thread shows it, after the web's user turn
// (components/render-message.tsx): the photos in a grid that opens a full-size
// viewer, the other files as chips that open in the in-app browser, the text
// in a bubble, then pasted or quoted content (collapsed) and pasted links.
// Only an http(s) URL, or for a file a relative /uploads one under the API
// base, is ever loaded or opened; anything else shows as a chip that does
// nothing. Old
// messages' <user-content> pasted blocks are split out of the text as the web
// splits them (lib/render/pasted-content).

import type { UIMessage } from 'ai'
import { useId, useState } from 'react'

import { FallbackImage } from '@/core/ui/FallbackImage'
import { ImageViewer } from '@/core/ui/ImageViewer'
import { isHttpUrl, openLink } from '@/features/thread/components/open-link'
import { faviconUrl } from '@/features/thread/model/citations'
import { splitPastedContent } from '@/lib/render/pasted-content'

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
  return isHttpUrl(url) ? url : null
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
  const pasted: string[] = []
  const quoted: string[] = []
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
      const body = (part.data as { text?: string } | undefined)?.text
      const list = part.type === 'data-pastedContent' ? pasted : quoted
      if (body) list.push(body)
    } else if (part.type === 'data-sourceUrl') {
      const url = (part.data as { url?: string } | undefined)?.url
      // A pasted link is a web page: never an upload under the API base.
      if (url) sources.push({ url, href: isHttpUrl(url) ? url : null })
    }
  }
  // As the web: legacy pasted blocks, then pasted parts, then quotes.
  const { cards, rest } = splitPastedContent(text)
  const quotes: Quote[] = [
    ...[...cards.filter(Boolean), ...pasted].map(body => ({
      label: 'Pasted content',
      text: body
    })),
    ...quoted.map(body => ({ label: 'Quoted context', text: body }))
  ]
  return { text: rest, photos, files, quotes, sources }
}

function Icon({
  d,
  className = 'size-5',
  testId
}: {
  d: string
  className?: string
  testId?: string
}) {
  return (
    <svg
      data-testid={testId}
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
const CHEVRON_ICON = 'M6 9l6 6 6-6'

/** A photo that shows a placeholder, not a broken image, when it fails. */
function Picture({ photo }: { photo: Photo }) {
  return (
    <FallbackImage
      src={photo.src}
      alt={photo.name}
      className="size-full object-cover"
      fallback={
        <div
          data-testid="image-placeholder"
          className="flex size-full items-center justify-center text-foreground/40"
        >
          <Icon d={PHOTO_ICON} className="size-8" />
        </div>
      }
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
          <Picture photo={photo} />
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

function FileChip({ file }: { file: FileItem }) {
  const body = (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-foreground/10 text-foreground/60">
        <Icon d={FILE_ICON} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{file.name}</span>
        <span className="block text-xs text-foreground/60">{file.type}</span>
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
      // 34 px to the eye; .hit-target makes the tap area 44 pt.
      className={`${look} hit-target touch-manipulation active:opacity-60`}
    >
      <FallbackImage
        src={faviconUrl(host)}
        alt=""
        className="size-4 shrink-0 rounded-sm"
        fallback={
          <Icon d={LINK_ICON} className="size-4 shrink-0" testId="link-icon" />
        }
      />
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
        className="hit-target flex min-h-9 touch-manipulation items-center gap-1.5 rounded-xl px-2 text-xs font-medium text-foreground/60 active:bg-foreground/10"
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
          className="selectable mt-1 max-h-60 overflow-auto border-l-2 border-foreground/20 pl-3 text-sm break-words whitespace-pre-wrap text-foreground/70"
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

/** Whether the message shows anything: UserMessage renders nothing if not. */
export function hasVisibleContent(
  message: UIMessage,
  baseUrl: string
): boolean {
  const { text, photos, files, quotes, sources } = readParts(
    message.parts,
    baseUrl
  )
  return (
    !!text || photos.length + files.length + quotes.length + sources.length > 0
  )
}

export function UserMessage({ message, baseUrl }: UserMessageProps) {
  const [viewing, setViewing] = useState<number | null>(null)
  if (!hasVisibleContent(message, baseUrl)) return null
  const { text, photos, files, quotes, sources } = readParts(
    message.parts,
    baseUrl
  )

  return (
    <div className="ml-auto flex max-w-[85%] flex-col items-end gap-2">
      {photos.length > 0 && <PhotoGrid photos={photos} onOpen={setViewing} />}
      {files.map((file, i) => (
        <FileChip key={i} file={file} />
      ))}
      {text && (
        <p
          data-testid="user-bubble"
          className="selectable rounded-3xl bg-foreground/8 px-4 py-2.5 text-base whitespace-pre-wrap"
        >
          {text}
        </p>
      )}
      {quotes.map((quote, i) => (
        <QuoteBlock key={i} quote={quote} />
      ))}
      {sources.length > 0 && (
        // Wrapped rows sit 44 px centre to centre, so the chips' hit areas
        // meet halfway between them. Under a quote toggle the row adds 2 px
        // to the column's 8 px gap: 10 px keeps the toggle's (36 px) and a
        // chip's (34 px) 44-pt hit areas from overlapping.
        <div
          className={`flex max-w-full flex-wrap justify-end gap-x-1.5 gap-y-2.5 ${
            quotes.length > 0 ? 'mt-0.5' : ''
          }`}
        >
          {sources.map((source, i) => (
            <SourceChip key={i} source={source} />
          ))}
        </div>
      )}
      <ImageViewer
        open={viewing !== null}
        images={photos.map(photo => ({ src: photo.src, alt: photo.name }))}
        start={viewing ?? 0}
        onClose={() => setViewing(null)}
      />
    </div>
  )
}
