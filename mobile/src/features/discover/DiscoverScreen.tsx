// The Discover tab: the news by topic, as Ask's web Discover page shows it.
// A row of topic chips (the choice is remembered), a lead story and compact
// rows under it, infinite scroll and pull to refresh. A story opens in the
// in-app browser; its Summarize button starts an Ask thread about it.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject
} from 'react'

import { useTabActive } from '@/app/Tabs'
import { haptic } from '@/core/haptics'
import { useStack } from '@/core/nav/stack'
import { usePullToRefresh } from '@/core/ui/usePullToRefresh'
import { TOPICS, type Topic } from '@/features/discover/discover-api'
import { useDiscoverTopic } from '@/features/discover/discover-topic'
import { DiscoverLeadCard, DiscoverRow } from '@/features/discover/DiscoverCard'
import { useDiscover, type Discover } from '@/features/discover/useDiscover'
import { openLink } from '@/features/thread/components/open-link'
import { openThread } from '@/features/thread/ThreadScreen'

/** How far below the visible feed the next page starts loading. */
const PRELOAD_MARGIN = '0px 0px 800px 0px'

/** The chip row's side padding: a chip scrolled into view keeps this gap. */
const CHIP_GUTTER = 16

const SKELETON_ROWS = 5

const PILL =
  'min-h-11 shrink-0 touch-manipulation rounded-full px-4 text-sm font-semibold active:opacity-50'

export function DiscoverScreen() {
  const [topic, setTopic, loaded] = useDiscoverTopic()
  // The feed waits for the stored topic, so it never loads one about to
  // change.
  if (!loaded) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <Title />
        <Skeleton />
      </main>
    )
  }
  return <DiscoverFeed topic={topic} onTopic={setTopic} />
}

function Title() {
  return (
    <h1 className="px-6 pt-6 pb-3 text-3xl font-bold tracking-tight">
      Discover
    </h1>
  )
}

function DiscoverFeed({
  topic,
  onTopic
}: {
  topic: Topic
  onTopic: (topic: Topic) => void
}) {
  const discover = useDiscover(topic)
  const { push } = useStack()
  const scroller = useRef<HTMLDivElement>(null)

  const changeTopic = (next: Topic) => {
    if (next === topic) return
    haptic('selection')
    scroller.current!.scrollTop = 0
    onTopic(next)
  }

  // Stable, so the memoized stories do not render again for a new feed.
  const summarize = useCallback(
    (url: string) => openThread(push, { question: `Summary: ${url}` }),
    [push]
  )

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header>
        <Title />
        <TopicChips topic={topic} onTopic={changeTopic} />
      </header>
      <PullScroller scroller={scroller} onRefresh={discover.refresh}>
        {/* Memoized on these fields (all stable between changes), so the
            feed does not render again for a pull. */}
        <Feed
          items={discover.items}
          status={discover.status}
          error={discover.error}
          hasMore={discover.hasMore}
          loadMore={discover.loadMore}
          refresh={discover.refresh}
          scroller={scroller}
          onOpen={openLink}
          onSummarize={summarize}
        />
      </PullScroller>
    </main>
  )
}

// --- Topics ---------------------------------------------------------------------

function TopicChips({
  topic,
  onTopic
}: {
  topic: Topic
  onTopic: (topic: Topic) => void
}) {
  const row = useRef<HTMLDivElement>(null)

  // Opening on a stored topic far along the row scrolls the row to it.
  useLayoutEffect(() => {
    const chip = row.current!.querySelector<HTMLElement>('[aria-checked=true]')!
    row.current!.scrollLeft = Math.max(0, chip.offsetLeft - CHIP_GUTTER)
    // Only the topic the screen opens on: a chip tapped later is in view.
  }, [])

  return (
    <div
      ref={row}
      role="radiogroup"
      aria-label="Topics"
      className="discover-chips flex gap-2 overflow-x-auto px-4 pb-3"
    >
      {TOPICS.map(t => {
        const checked = t.key === topic
        return (
          <button
            key={t.key}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onTopic(t.key)}
            className={`${PILL} whitespace-nowrap ${
              checked
                ? 'bg-foreground text-background'
                : 'bg-muted text-foreground'
            }`}
          >
            {t.label}
          </button>
        )
      })}
    </div>
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
  // Back at rest (or held while refreshing), the feed settles with a
  // transition; under the finger it follows without one.
  const settling = pull === 0 || refreshing
  return (
    <div
      ref={scroller}
      data-testid="discover-scroll"
      className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <PullIndicator pull={pull} refreshing={refreshing} />
      <div
        data-testid="discover-content"
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

// --- The feed -------------------------------------------------------------------

type FeedProps = Pick<
  Discover,
  'items' | 'status' | 'error' | 'hasMore' | 'loadMore' | 'refresh'
> & {
  scroller: RefObject<HTMLDivElement | null>
  onOpen: (url: string) => void
  onSummarize: (url: string) => void
}

const Feed = memo(function Feed({
  items,
  status,
  error,
  hasMore,
  loadMore,
  refresh,
  scroller,
  onOpen,
  onSummarize
}: FeedProps) {
  const active = useTabActive()

  // The end of the feed: in view (or nearly), it asks for the next page. It
  // is watched again whenever the feed changes (a page landed, even one of
  // stories already shown), as it may still be in view. A hidden tab pages
  // nothing.
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
  }, [active, hasMore, loadMore, items, scroller])

  const more = hasMore && (
    <div
      ref={sentinel}
      data-testid="discover-more"
      className="flex h-16 items-center justify-center"
    >
      <span className="size-5 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground/60" />
    </div>
  )

  if (items.length === 0) {
    if (status === 'loading' || status === 'refreshing') return <Skeleton />
    if (status === 'error') {
      return (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 px-8 pt-16 text-center"
        >
          <p className="text-lg font-semibold">Couldn’t load the news</p>
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
    // A page came back with nothing new, but the next may not: load it.
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
        <p className="text-lg font-semibold">No stories right now</p>
        <p className="text-sm text-muted-foreground">
          Try another topic, or check again in a while.
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          className={`${PILL} bg-foreground text-background`}
        >
          Refresh
        </button>
      </div>
    )
  }

  const [lead, ...rest] = items
  return (
    <>
      {status === 'error' && (
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
      <DiscoverLeadCard item={lead} onOpen={onOpen} onSummarize={onSummarize} />
      {rest.length > 0 && (
        <ul aria-label="More stories">
          {rest.map(item => (
            <DiscoverRow
              key={item.url}
              item={item}
              onOpen={onOpen}
              onSummarize={onSummarize}
            />
          ))}
        </ul>
      )}
      {more}
    </>
  )
})

function Skeleton() {
  return (
    <div
      role="status"
      aria-label="Loading stories"
      className="flex animate-pulse flex-col"
    >
      <div className="mx-4 mb-2 overflow-hidden rounded-2xl bg-muted">
        <div className="aspect-video w-full bg-foreground/8" />
        <div className="flex flex-col gap-2 px-4 py-4">
          <div className="h-4 w-5/6 rounded bg-foreground/8" />
          <div className="h-3 w-2/3 rounded bg-foreground/8" />
        </div>
      </div>
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <div className="h-16 w-24 shrink-0 rounded-lg bg-foreground/8" />
          <div className="flex flex-1 flex-col gap-2">
            <div className="h-4 w-full rounded bg-foreground/8" />
            <div className="h-4 w-2/3 rounded bg-foreground/8" />
          </div>
        </div>
      ))}
    </div>
  )
}
