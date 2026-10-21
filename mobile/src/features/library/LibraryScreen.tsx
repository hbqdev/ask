// The Library tab: the user's chats in date sections (or by title), with the
// total, a remembered sort, search, pull to refresh, infinite scroll, and
// swipe to delete or rename. Rows show from the offline cache at once while
// the list revalidates; a failed load keeps them and says so.

import { App } from '@capacitor/app'
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject
} from 'react'

import { useSelectTab, useTabActive } from '@/app/Tabs'
import { useStack } from '@/core/nav/stack'
import { ConfirmSheet } from '@/core/ui/ConfirmSheet'
import { Sheet } from '@/core/ui/Sheet'
import { TextPromptSheet } from '@/core/ui/TextPromptSheet'
import { usePullToRefresh } from '@/core/ui/usePullToRefresh'
import { ChatRowItem } from '@/features/library/ChatRowItem'
import { groupByDate } from '@/features/library/group-by-date'
import {
  CHAT_TITLE_MAX_LENGTH,
  type ChatRow,
  type ChatSort
} from '@/features/library/library-api'
import { LIBRARY_SORTS, useLibrarySort } from '@/features/library/library-sort'
import {
  useChatSearch,
  useLibrary,
  type ChatSearch,
  type Library
} from '@/features/library/useLibrary'
import { openThread } from '@/features/thread/ThreadScreen'

/** How far below the visible list the next page starts loading. */
const PRELOAD_MARGIN = '0px 0px 600px 0px'

const SKELETON_ROWS = 6

const PILL =
  'min-h-11 shrink-0 touch-manipulation rounded-full px-4 text-sm font-semibold active:opacity-50'

export function LibraryScreen() {
  const [sort, setSort, loaded] = useLibrarySort()
  // The list waits for the stored sort, so it neither fetches nor shows the
  // cache in an order about to change.
  if (!loaded) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <header className="px-4 pt-6 pb-3">
          <h1 className="px-2 text-3xl font-bold tracking-tight">Library</h1>
        </header>
        <Skeleton />
      </main>
    )
  }
  return <LibraryList sort={sort} onSort={setSort} />
}

function LibraryList({
  sort,
  onSort
}: {
  sort: ChatSort
  onSort: (sort: ChatSort) => void
}) {
  const library = useLibrary({ sort })
  const search = useChatSearch()
  const { push } = useStack()
  const searching = search.query.trim() !== ''

  const scroller = useRef<HTMLDivElement>(null)

  const [deleting, setDeleting] = useState<ChatRow | null>(null)
  const [renaming, setRenaming] = useState<ChatRow | null>(null)

  const open = useCallback(
    (chatId: string, title: string) => openThread(push, { chatId, title }),
    [push]
  )
  const openRow = useCallback(
    (chat: ChatRow) => open(chat.id, chat.title),
    [open]
  )

  const changeSort = (next: ChatSort) => {
    scroller.current!.scrollTop = 0
    onSort(next)
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <LibraryHeader
        total={library.total}
        sort={sort}
        onSort={changeSort}
        search={search}
      />
      <PullScroller scroller={scroller} onRefresh={library.refresh}>
        {searching ? (
          <SearchResults search={search} onOpen={open} />
        ) : (
          // Memoized on these fields (all stable between changes), so the
          // list does not render again for a sheet, a keystroke or a pull.
          <ChatList
            chats={library.chats}
            status={library.status}
            error={library.error}
            hasMore={library.hasMore}
            loadMore={library.loadMore}
            refresh={library.refresh}
            sort={sort}
            scroller={scroller}
            onOpen={openRow}
            onDelete={setDeleting}
            onRename={setRenaming}
          />
        )}
      </PullScroller>

      <ConfirmSheet
        open={deleting !== null}
        title="Delete this chat?"
        message="This can’t be undone."
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={() => void library.remove(deleting!.id)}
        onClose={() => setDeleting(null)}
      />
      <TextPromptSheet
        open={renaming !== null}
        title="Rename chat"
        initialValue={renaming?.title ?? ''}
        maxLength={CHAT_TITLE_MAX_LENGTH}
        confirmLabel="Rename"
        onSubmit={title => void library.rename(renaming!.id, title)}
        onClose={() => setRenaming(null)}
      />
    </main>
  )
}

// --- Header -------------------------------------------------------------------

function LibraryHeader({
  total,
  sort,
  onSort,
  search
}: {
  total: number | undefined
  sort: ChatSort
  onSort: (sort: ChatSort) => void
  search: ChatSearch
}) {
  const [sortOpen, setSortOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const sortLabel = LIBRARY_SORTS.find(s => s.value === sort)!.label

  // Return runs the semantic search and puts the keyboard away.
  const submit = (e: FormEvent) => {
    e.preventDefault()
    search.submit()
    input.current!.blur()
  }

  return (
    <header className="flex flex-col gap-3 px-4 pt-6 pb-3">
      <div className="flex items-end justify-between gap-3 px-2">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight">Library</h1>
          {total !== undefined && (
            <p className="text-sm text-muted-foreground">
              {total} {total === 1 ? 'chat' : 'chats'}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label={`Sort: ${sortLabel}`}
          onClick={() => setSortOpen(true)}
          className={`${PILL} inline-flex items-center gap-1 bg-muted text-foreground`}
        >
          {sortLabel}
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>

      <form role="search" onSubmit={submit} className="relative">
        <input
          ref={input}
          type="search"
          aria-label="Search chats"
          placeholder="Search chats"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          value={search.query}
          onChange={e => search.setQuery(e.target.value)}
          className="library-search min-h-11 w-full rounded-xl bg-muted pr-11 pl-4 text-base text-foreground outline-none placeholder:text-muted-foreground"
        />
        {search.query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => search.setQuery('')}
            className="absolute inset-y-0 right-0 flex w-11 touch-manipulation items-center justify-center text-muted-foreground active:opacity-50"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        )}
      </form>

      <Sheet open={sortOpen} onClose={() => setSortOpen(false)} title="Sort by">
        <div
          role="radiogroup"
          aria-label="Sort by"
          className="flex flex-col gap-1 pb-2"
        >
          {LIBRARY_SORTS.map(option => {
            const checked = option.value === sort
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => {
                  setSortOpen(false)
                  onSort(option.value)
                }}
                className={`min-h-12 touch-manipulation rounded-xl px-4 text-left text-base active:bg-muted ${
                  checked ? 'font-semibold text-mark-blue' : 'text-foreground'
                }`}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </Sheet>
    </header>
  )
}

// --- Pull to refresh ------------------------------------------------------------

/**
 * The scroller, with pull to refresh. The pull is state here, not in the
 * screen: each touchmove renders only this wrapper and the indicator, while
 * `children` (the same element as before) is not rendered again. The scroller
 * stays mounted for the screen's whole life, as the pull hook binds to it once.
 */
function PullScroller({
  scroller,
  onRefresh,
  children
}: {
  scroller: RefObject<HTMLDivElement | null>
  onRefresh: () => Promise<void>
  children: ReactNode
}) {
  const { pull, refreshing } = usePullToRefresh(scroller, onRefresh)
  // Back at rest (or held while refreshing), the list settles with a
  // transition; under the finger it follows without one.
  const settling = pull === 0 || refreshing
  return (
    <div
      ref={scroller}
      data-testid="library-scroll"
      className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <PullIndicator pull={pull} refreshing={refreshing} />
      <div
        data-testid="library-content"
        className={`relative bg-background pb-6 ${settling ? 'pull-settle' : ''}`}
        style={pull ? { transform: `translate3d(0, ${pull}px, 0)` } : undefined}
      >
        {children}
      </div>
    </div>
  )
}

function PullIndicator({
  pull,
  refreshing
}: {
  pull: number
  refreshing: boolean
}) {
  return (
    <div
      aria-hidden={!refreshing}
      className="absolute inset-x-0 top-0 flex h-16 items-center justify-center"
      style={{ opacity: refreshing ? 1 : Math.min(1, pull / 64) }}
    >
      <span
        role={refreshing ? 'status' : undefined}
        aria-label={refreshing ? 'Refreshing' : undefined}
        className={`size-6 rounded-full border-2 border-foreground/20 border-t-foreground/70 ${
          refreshing ? 'animate-spin' : ''
        }`}
        style={refreshing ? undefined : { transform: `rotate(${pull * 4}deg)` }}
      />
    </div>
  )
}

// --- The list -------------------------------------------------------------------

/** Today's local midnight (ms): it changes once a day. */
function startOfToday() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

type ChatListProps = Pick<
  Library,
  'chats' | 'status' | 'error' | 'hasMore' | 'loadMore' | 'refresh'
> & {
  sort: ChatSort
  scroller: RefObject<HTMLDivElement | null>
  onOpen: (chat: ChatRow) => void
  onDelete: (chat: ChatRow) => void
  onRename: (chat: ChatRow) => void
}

const ChatList = memo(function ChatList({
  chats,
  status,
  error,
  hasMore,
  loadMore,
  refresh,
  sort,
  scroller,
  onOpen,
  onDelete,
  onRename
}: ChatListProps) {
  const selectTab = useSelectTab()
  const active = useTabActive()
  const idPrefix = useId()

  // The end of the list: in view (or nearly), it asks for the next page. It is
  // watched again whenever the list changes (a page landed, even one of rows
  // already shown), as it may still be in view. A hidden tab pages nothing.
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
  }, [active, hasMore, loadMore, chats, scroller])

  // Rows' times and the sections depend on the day only, so `now` (and every
  // memoized row) stays the same until midnight. A render takes up a new
  // day: showing the tab renders the list again (`active` changed), and so
  // does the app coming back on another day than it last rendered.
  const [, setDay] = useState(startOfToday)
  useEffect(() => {
    const handle = App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) setDay(startOfToday())
    })
    return () => {
      void handle.then(h => h.remove())
    }
  }, [])
  const today = startOfToday()
  const now = useMemo(() => new Date(today), [today])
  const key = sort === 'recent' ? 'lastViewedAt' : 'createdAt'
  const groups = useMemo(
    () => (sort === 'title' ? null : groupByDate(chats, now, key)),
    [chats, now, key, sort]
  )

  const more = hasMore && (
    <div
      ref={sentinel}
      data-testid="library-more"
      className="flex h-16 items-center justify-center"
    >
      <span className="size-5 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground/60" />
    </div>
  )

  if (chats.length === 0) {
    if (status === 'loading' || status === 'refreshing') return <Skeleton />
    if (status === 'error' || error) {
      return (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 px-8 pt-16 text-center"
        >
          <p className="text-lg font-semibold">Couldn’t load your chats</p>
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
    // Every loaded row was deleted, but the server has more: load them.
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
        <p className="text-lg font-semibold">No chats yet</p>
        <p className="text-sm text-muted-foreground">
          Questions you ask show up here.
        </p>
        <button
          type="button"
          onClick={() => selectTab?.('ask')}
          className={`${PILL} bg-foreground text-background`}
        >
          Ask a question
        </button>
      </div>
    )
  }

  const timeOf = (chat: ChatRow) => chat[key] ?? chat.createdAt
  const rows = (list: ChatRow[]) =>
    list.map(chat => (
      <ChatRowItem
        key={chat.id}
        chat={chat}
        time={timeOf(chat)}
        now={now}
        onOpen={onOpen}
        onDelete={onDelete}
        onRename={onRename}
      />
    ))

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
      {groups === null ? (
        <ul>{rows(chats)}</ul>
      ) : (
        groups.map((group, i) => {
          const headingId = `${idPrefix}-section-${i}`
          return (
            <section key={group.label} aria-labelledby={headingId}>
              <h2
                id={headingId}
                className="sticky top-0 z-10 bg-background/95 px-6 pt-4 pb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase backdrop-blur"
              >
                {group.label}
              </h2>
              <ul>{rows(group.rows)}</ul>
            </section>
          )
        })
      )}
      {more}
    </>
  )
})

function Skeleton() {
  return (
    <div
      role="status"
      aria-label="Loading chats"
      className="flex animate-pulse flex-col"
    >
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 px-4 py-4">
          <div className="h-4 w-3/4 rounded bg-foreground/8" />
          <div className="h-3 w-1/4 rounded bg-foreground/8" />
        </div>
      ))}
    </div>
  )
}

// --- Search results -------------------------------------------------------------

function SearchResults({
  search,
  onOpen
}: {
  search: ChatSearch
  onOpen: (chatId: string, title: string) => void
}) {
  const { results, status, query } = search
  if (results.length === 0) {
    if (status === 'error') {
      return (
        <p
          role="alert"
          className="px-8 pt-16 text-center text-sm text-muted-foreground"
        >
          Couldn’t search. Check your connection and try again.
        </p>
      )
    }
    if (status === 'ready') {
      return (
        <p className="px-8 pt-16 text-center text-sm text-muted-foreground">
          No chats match “{query.trim()}”
        </p>
      )
    }
    return (
      <p
        role="status"
        className="px-8 pt-16 text-center text-sm text-muted-foreground"
      >
        Searching…
      </p>
    )
  }
  return (
    <ul aria-label="Search results">
      {results.map((hit, i) => (
        <li
          key={`${i}:${hit.chatId}`}
          className="border-b border-border last:border-b-0"
        >
          <button
            type="button"
            onClick={() => onOpen(hit.chatId, hit.title)}
            className="flex w-full touch-manipulation flex-col gap-1 px-4 py-3 text-left active:bg-muted"
          >
            <span className="line-clamp-1 text-base font-medium">
              {hit.title || 'Untitled'}
            </span>
            <span className="line-clamp-2 text-sm text-muted-foreground">
              {hit.snippet}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
