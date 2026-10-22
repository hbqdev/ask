// The Library's Notes segment: the user's saved answers in date sections (by
// last update), with pull to refresh, infinite scroll, a tap to open one and
// a swipe to delete it. Memoized with no props, so the Library around it
// (a segment switch included) never renders it again.

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'

import { useTabActive } from '@/app/Tabs'
import { useStack } from '@/core/nav/stack'
import { ConfirmSheet } from '@/core/ui/ConfirmSheet'
import { PullScroller } from '@/core/ui/PullScroller'
import { SwipeRow } from '@/core/ui/SwipeRow'
import { groupByDate } from '@/features/library/group-by-date'
import { relativeTime } from '@/features/library/relative-time'
import { useToday } from '@/features/library/useToday'
import { notePreview } from '@/features/notes/note-preview'
import type { Note } from '@/features/notes/notes-api'
import { openNote } from '@/features/notes/NoteScreen'
import { useNotes, type Notes } from '@/features/notes/useNotes'

/** How far below the visible list the next page starts loading. */
const PRELOAD_MARGIN = '0px 0px 600px 0px'

const SKELETON_ROWS = 6

const PILL =
  'min-h-11 shrink-0 touch-manipulation rounded-full px-4 text-sm font-semibold active:opacity-50'

// Off-screen rows skip layout and paint; this is the size they hold meanwhile.
const ROW_STYLE = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 88px'
} as const

export const NotesList = memo(function NotesList() {
  const notes = useNotes()
  const { push } = useStack()
  const scroller = useRef<HTMLDivElement>(null)
  const [deleting, setDeleting] = useState<Note | null>(null)

  const open = useCallback((note: Note) => openNote(push, note), [push])

  return (
    <>
      <PullScroller
        scroller={scroller}
        onRefresh={notes.refresh}
        testId="notes"
      >
        <NoteRows
          notes={notes.notes}
          status={notes.status}
          error={notes.error}
          hasMore={notes.hasMore}
          loadMore={notes.loadMore}
          refresh={notes.refresh}
          scroller={scroller}
          onOpen={open}
          onDelete={setDeleting}
        />
      </PullScroller>
      <ConfirmSheet
        open={deleting !== null}
        title="Delete this note?"
        message="This can’t be undone."
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={() => void notes.remove(deleting!.id)}
        onClose={() => setDeleting(null)}
      />
    </>
  )
})

// --- The rows -----------------------------------------------------------------

type NoteRowsProps = Pick<
  Notes,
  'notes' | 'status' | 'error' | 'hasMore' | 'loadMore' | 'refresh'
> & {
  scroller: RefObject<HTMLDivElement | null>
  onOpen: (note: Note) => void
  onDelete: (note: Note) => void
}

// Memoized on these fields (all stable between changes), so the rows do not
// render again for a sheet or a pull.
const NoteRows = memo(function NoteRows({
  notes,
  status,
  error,
  hasMore,
  loadMore,
  refresh,
  scroller,
  onOpen,
  onDelete
}: NoteRowsProps) {
  const active = useTabActive()
  const idPrefix = useId()
  const now = useToday()

  // The end of the list: in view (or nearly), it asks for the next page. It is
  // watched again whenever the list changes, as it may still be in view. A
  // hidden tab pages nothing.
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el || !active) return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) void loadMore()
      },
      { root: scroller.current, rootMargin: PRELOAD_MARGIN }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [active, hasMore, loadMore, notes, scroller])

  const groups = useMemo(
    () => groupByDate(notes, now, 'updatedAt'),
    [notes, now]
  )

  const more = hasMore && (
    <div
      ref={sentinel}
      data-testid="notes-more"
      className="flex h-16 items-center justify-center"
    >
      <span className="size-5 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground/60" />
    </div>
  )

  if (notes.length === 0) {
    if (status === 'loading' || status === 'refreshing') return <Skeleton />
    if (status === 'unavailable') {
      return (
        <div className="flex flex-col items-center gap-3 px-8 pt-16 text-center">
          <p className="text-lg font-semibold">
            Notes aren’t available on this server
          </p>
          <p className="text-sm text-muted-foreground">
            It runs without accounts, so it keeps no notes.
          </p>
        </div>
      )
    }
    if (status === 'error') {
      return (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 px-8 pt-16 text-center"
        >
          <p className="text-lg font-semibold">Couldn’t load your notes</p>
          <p className="text-sm text-muted-foreground">{error}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className={`${PILL} bg-foreground text-background`}
          >
            Retry
          </button>
        </div>
      )
    }
    // Every loaded note was deleted, but the server has more: load them.
    if (hasMore) {
      return (
        <>
          <Skeleton />
          {more}
        </>
      )
    }
    return (
      <div className="flex flex-col items-center gap-3 px-8 pt-16 text-center">
        <p className="text-lg font-semibold">No notes yet</p>
        <p className="text-sm text-muted-foreground">
          Tap Save to notes under an answer to keep it here.
        </p>
      </div>
    )
  }

  return (
    <>
      {error && (
        <div
          role="alert"
          className="mx-4 mb-2 flex items-center gap-3 rounded-2xl bg-red-500/10 px-4 py-1 text-sm text-red-600 dark:text-red-400"
        >
          <p className="min-w-0 flex-1">{error}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="min-h-11 shrink-0 touch-manipulation rounded-full px-3 font-semibold active:opacity-50"
          >
            Retry
          </button>
        </div>
      )}
      {groups.map((group, i) => {
        const headingId = `${idPrefix}-section-${i}`
        return (
          <section key={group.label} aria-labelledby={headingId}>
            <h2
              id={headingId}
              className="sticky top-0 z-10 bg-background/95 px-6 pt-4 pb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase backdrop-blur"
            >
              {group.label}
            </h2>
            <ul>
              {group.rows.map(note => (
                <NoteRowItem
                  key={note.id}
                  note={note}
                  now={now}
                  onOpen={onOpen}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          </section>
        )
      })}
      {more}
    </>
  )
})

/** One note: its title, a plain-text preview and when it was saved. */
const NoteRowItem = memo(function NoteRowItem({
  note,
  now,
  onOpen,
  onDelete
}: {
  note: Note
  now: Date
  onOpen: (note: Note) => void
  onDelete: (note: Note) => void
}) {
  const preview = useMemo(() => notePreview(note.content), [note.content])
  return (
    <li style={ROW_STYLE} className="border-b border-border last:border-b-0">
      <SwipeRow
        actions={[
          {
            label: 'Delete',
            tone: 'destructive',
            onAction: () => onDelete(note)
          }
        ]}
        onPress={() => onOpen(note)}
      >
        <div className="flex min-h-[88px] flex-col justify-center gap-1 px-4 py-3">
          <span className="line-clamp-1 text-base leading-snug font-medium">
            {note.title || 'Untitled'}
          </span>
          {preview && (
            <span className="line-clamp-2 text-sm text-muted-foreground">
              {preview}
            </span>
          )}
          <time
            dateTime={note.updatedAt}
            className="text-xs text-muted-foreground"
          >
            {relativeTime(note.updatedAt, now)}
          </time>
        </div>
      </SwipeRow>
    </li>
  )
})

function Skeleton() {
  return (
    <div
      role="status"
      aria-label="Loading notes"
      className="flex animate-pulse flex-col"
    >
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 px-4 py-4">
          <div className="h-4 w-3/4 rounded bg-foreground/8" />
          <div className="h-3 w-full rounded bg-foreground/8" />
          <div className="h-3 w-1/4 rounded bg-foreground/8" />
        </div>
      ))}
    </div>
  )
}
