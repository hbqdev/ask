// One note: its title, when it was saved, and its content rendered as an
// answer is, with Share and Delete in the header and "Open chat" for a note
// saved from a chat. A note from the Notes list shows at once from the notes
// cache while the server's copy loads; one the server no longer has says so.

import { Share } from '@capacitor/share'
import {
  Suspense,
  useCallback,
  useEffect,
  useState,
  type ReactNode
} from 'react'

import { useApi } from '@/core/api/ApiProvider'
import { ApiError } from '@/core/api/errors'
import { useAuth } from '@/core/auth/AuthProvider'
import { useStack, type Stack } from '@/core/nav/stack'
import { ConfirmSheet } from '@/core/ui/ConfirmSheet'
import {
  deleteNote,
  fetchNote,
  isNotesUnavailable,
  NOTES_UNAVAILABLE,
  type Note
} from '@/features/notes/notes-api'
import { dropNote, findNote } from '@/features/notes/notes-cache'
import {
  LazyAnswerMarkdown,
  PlainAnswer
} from '@/features/thread/components/AssistantTurn'
import { isShareCancelled, reasonOf } from '@/features/thread/share-api'
import { openThread } from '@/features/thread/ThreadScreen'

export const SHARE_NOTE_ERROR = 'Couldn’t share the note.'
export const DELETE_NOTE_ERROR = 'Couldn’t delete the note.'

/** Opens `note`'s screen over the current one. */
export function openNote(push: Stack['push'], note: Note) {
  push({
    key: `note:${note.id}`,
    render: () => <NoteScreen noteId={note.id} />
  })
}

/** Where the note's load stands: shown, gone, or failed. */
type Load =
  | { kind: 'loading' }
  | { kind: 'shown'; note: Note }
  | { kind: 'missing' }
  | { kind: 'failed'; error: string; unavailable: boolean }

const BACK_ICON = 'M15 5l-7 7 7 7'
const SHARE_ICON = 'M12 3v12M7 8l5-5 5 5M5 13v6h14v-6'
const DELETE_ICON =
  'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3'

const NO_SOURCES: never[] = []

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

function HeaderButton({
  label,
  onClick,
  disabled,
  busy,
  d
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  d: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-busy={busy || undefined}
      onClick={onClick}
      disabled={disabled}
      className="flex size-11 shrink-0 touch-manipulation items-center justify-center rounded-full text-foreground/70 active:opacity-50 disabled:opacity-30"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={d} />
      </svg>
    </button>
  )
}

function Message({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-8 pt-16 text-center">
      {children}
    </div>
  )
}

export function NoteScreen({ noteId }: { noteId: string }) {
  const { push, pop } = useStack()
  const { client } = useApi()
  const userId = useAuth().session?.user.id

  // A listed note shows at once; the server's copy replaces it.
  const [load, setLoad] = useState<Load>(() => {
    const cached = userId ? findNote(userId, noteId) : undefined
    return cached ? { kind: 'shown', note: cached } : { kind: 'loading' }
  })
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const fetchIt = useCallback(async () => {
    try {
      const note = await fetchNote(client, noteId)
      setLoad({ kind: 'shown', note })
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        if (userId) dropNote(userId, noteId)
        setLoad({ kind: 'missing' })
        return
      }
      // A cached note stays: only a note with nothing to show says why.
      setLoad(l =>
        l.kind === 'shown'
          ? l
          : {
              kind: 'failed',
              error: isNotesUnavailable(e) ? NOTES_UNAVAILABLE : reasonOf(e),
              unavailable: isNotesUnavailable(e)
            }
      )
    }
  }, [client, noteId, userId])

  useEffect(() => {
    void fetchIt()
  }, [fetchIt])

  const retry = () => {
    setLoad({ kind: 'loading' })
    void fetchIt()
  }

  const note = load.kind === 'shown' ? load.note : null

  const share = async () => {
    setError(null)
    try {
      await Share.share({ title: note!.title, text: note!.content })
    } catch (e) {
      if (!isShareCancelled(e)) setError(SHARE_NOTE_ERROR)
    }
  }

  const remove = async () => {
    setError(null)
    setDeleting(true)
    try {
      await deleteNote(client, noteId)
    } catch (e) {
      // Already gone on the server: that is what the user wanted.
      if (!(e instanceof ApiError && e.status === 404)) {
        setDeleting(false)
        setError(`${DELETE_NOTE_ERROR} ${reasonOf(e)}`)
        return
      }
    }
    if (userId) dropNote(userId, noteId)
    pop()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-1 border-b border-foreground/10 px-1 py-1">
        <HeaderButton label="Back" onClick={pop} d={BACK_ICON} />
        <div className="flex">
          <HeaderButton
            label="Share"
            onClick={() => void share()}
            disabled={!note}
            d={SHARE_ICON}
          />
          <HeaderButton
            label={deleting ? 'Deleting' : 'Delete'}
            onClick={() => setConfirming(true)}
            disabled={!note || deleting}
            busy={deleting}
            d={DELETE_ICON}
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {error && (
          <p role="alert" className="pb-3 text-sm text-red-500">
            {error}
          </p>
        )}
        {note ? (
          <article className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl leading-tight font-bold tracking-tight">
                {note.title || 'Untitled'}
              </h1>
              <p className="text-sm text-muted-foreground">
                <time dateTime={note.updatedAt}>
                  {dateFormat.format(new Date(note.updatedAt))}
                </time>
              </p>
            </div>
            <Suspense fallback={<PlainAnswer text={note.content} />}>
              <LazyAnswerMarkdown
                text={note.content}
                sources={NO_SOURCES}
                streaming={false}
              />
            </Suspense>
            {note.chatId && (
              <button
                type="button"
                onClick={() => openThread(push, { chatId: note.chatId! })}
                className="mt-2 min-h-11 self-start touch-manipulation rounded-full bg-muted px-4 text-sm font-semibold text-foreground active:opacity-50"
              >
                Open chat
              </button>
            )}
          </article>
        ) : load.kind === 'missing' ? (
          <Message>
            <p className="text-lg font-semibold">This note was deleted.</p>
          </Message>
        ) : load.kind === 'failed' ? (
          load.unavailable ? (
            <Message>
              <p className="text-lg font-semibold">{load.error}</p>
            </Message>
          ) : (
            <div
              role="alert"
              className="flex flex-col items-center gap-3 px-8 pt-16 text-center"
            >
              <p className="text-lg font-semibold">Couldn’t load this note</p>
              <p className="text-sm text-muted-foreground">{load.error}</p>
              <button
                type="button"
                onClick={retry}
                className="min-h-11 touch-manipulation rounded-full bg-foreground px-4 text-sm font-semibold text-background active:opacity-50"
              >
                Retry
              </button>
            </div>
          )
        ) : (
          <div
            role="status"
            aria-label="Loading note"
            className="flex animate-pulse flex-col gap-3"
          >
            <div className="h-7 w-2/3 rounded bg-foreground/8" />
            <div className="h-4 w-full rounded bg-foreground/8" />
            <div className="h-4 w-5/6 rounded bg-foreground/8" />
          </div>
        )}
      </div>

      <ConfirmSheet
        open={confirming}
        title="Delete this note?"
        message="This can’t be undone."
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={() => void remove()}
        onClose={() => setConfirming(false)}
      />
    </div>
  )
}
