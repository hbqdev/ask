// The composer's attachments, in a row above the text field: a thumbnail for
// an image or an icon for any other file, the name, a ring while it is being
// prepared or uploaded, why it failed (with Retry when another try may
// help), what the server's indexing said, and × to take it off the question.
// A failure is announced (VoiceOver reads it as it appears), and Retry and ×
// each get a 44-point hit area.

import { ingestNote, type Attachment } from '@/features/compose/useAttachments'

export type AttachmentChipsProps = {
  items: Attachment[]
  onRemove(id: string): void
  onRetry(id: string): void
}

/** The ring's radius in its 40-unit box; its length is the full circle. */
const RING_RADIUS = 16
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

function ProgressRing({ item }: { item: Attachment }) {
  const converting = item.status === 'converting'
  const percent = Math.round(item.progress * 100)
  return (
    <div
      role="progressbar"
      aria-label={`${converting ? 'Preparing' : 'Uploading'} ${item.name}`}
      aria-valuemin={converting ? undefined : 0}
      aria-valuemax={converting ? undefined : 100}
      aria-valuenow={converting ? undefined : percent}
      className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/35"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 40 40"
        className={`size-7 -rotate-90 text-white ${converting ? 'animate-spin' : ''}`}
      >
        <circle
          cx="20"
          cy="20"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.3}
          strokeWidth={4}
        />
        <circle
          cx="20"
          cy="20"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={RING_LENGTH}
          // Converting has no measure: a quarter arc spins instead.
          strokeDashoffset={
            converting ? RING_LENGTH * 0.75 : RING_LENGTH * (1 - item.progress)
          }
          className="transition-[stroke-dashoffset] duration-150"
        />
      </svg>
    </div>
  )
}

function FileIcon() {
  return (
    <svg
      data-testid="file-icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  )
}

function Chip({
  item,
  onRemove,
  onRetry
}: { item: Attachment } & Omit<AttachmentChipsProps, 'items'>) {
  const busy = item.status === 'converting' || item.status === 'uploading'
  const failed = item.status === 'error'
  const note = failed ? item.error : ingestNote(item)
  return (
    <li
      className={`relative flex w-48 shrink-0 items-center gap-2 rounded-2xl bg-foreground/8 p-1.5 pr-10 ${
        failed ? 'ring-1 ring-red-500/70' : ''
      }`}
    >
      <div className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-foreground/10 text-foreground/60">
        {item.previewUrl ? (
          <img
            src={item.previewUrl}
            alt=""
            className="size-full object-cover"
          />
        ) : (
          <FileIcon />
        )}
        {busy && <ProgressRing item={item} />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm leading-5 font-medium">{item.name}</p>
        {note && (
          <p
            role={failed ? 'alert' : undefined}
            className={`truncate text-xs leading-4 ${
              failed ? 'text-red-500' : 'text-foreground/50'
            }`}
          >
            {failed && <span className="sr-only">{item.name}: </span>}
            {note}
          </p>
        )}
        {failed && item.retryable && (
          <button
            type="button"
            aria-label={`Retry ${item.name}`}
            onClick={() => onRetry(item.id)}
            // The hit area reaches past the text without growing the chip much.
            className="-my-2 -ml-2 flex min-h-11 min-w-11 touch-manipulation items-center px-2 text-xs leading-5 font-semibold text-foreground underline active:opacity-50"
          >
            Retry
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label={`Remove ${item.name}`}
        onClick={() => onRemove(item.id)}
        className="group absolute top-0 right-0 flex min-h-11 min-w-11 touch-manipulation items-start justify-end p-0.5 text-foreground/60"
      >
        <span className="flex size-7 items-center justify-center rounded-full group-active:bg-foreground/10">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </span>
      </button>
    </li>
  )
}

export function AttachmentChips({
  items,
  onRemove,
  onRetry
}: AttachmentChipsProps) {
  if (items.length === 0) return null
  return (
    <ul
      aria-label="Attachments"
      className="-mx-1 flex gap-2 overflow-x-auto px-1 pt-2 pb-1"
    >
      {items.map(item => (
        <Chip key={item.id} item={item} onRemove={onRemove} onRetry={onRetry} />
      ))}
    </ul>
  )
}
