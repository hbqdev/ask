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
  type RefObject
} from 'react'

import { useTabActive } from '@/app/Tabs'
import { haptic } from '@/core/haptics'
import { chipClass, READABLE } from '@/core/ui/classes'
import { useStack } from '@/core/nav/stack'
import { PullScroller } from '@/core/ui/PullScroller'
import { TOPICS, type Topic } from '@/features/discover/discover-api'
import { useDiscoverTopic } from '@/features/discover/discover-topic'
import { DiscoverLeadCard, DiscoverRow } from '@/features/discover/DiscoverCard'
import { useDiscover, type Discover } from '@/features/discover/useDiscover'
import { openLink } from '@/features/thread/components/open-link'
import { openThread } from '@/features/thread/ThreadScreen'

/** How far below the visible feed the next page starts loading. */
const PRELOAD_MARGIN = '0px 0px 800px 0px'

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
    <h1
      className={`${READABLE} px-6 pt-6 pb-3 text-3xl font-bold tracking-tight`}
    >
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
      <PullScroller
        scroller={scroller}
        onRefresh={discover.refresh}
        testId="discover"
      >
        {/* Memoized on these fields (all stable between changes), so the
            feed does not render again for a pull. On an iPad the stories
            sit in the readable column; the pull area spans the screen. */}
        <div className={READABLE}>
          <Feed
            items={discover.items}
            status={discover.status}
            error={discover.error}
            hasMore={discover.hasMore}
            loadMore={discover.loadMore}
            refresh={discover.refresh}
            retry={discover.retry}
            scroller={scroller}
            onOpen={openLink}
            onSummarize={summarize}
          />
        </div>
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

  // Opening on a stored topic far along the row scrolls the row to it, the
  // chip landing where the first one starts: the row's padding, 16 px on a
  // phone, in line with the readable column on an iPad. The row is
  // positioned, so a chip's offsetLeft is from the row itself, not from
  // whatever positioned box holds the screen.
  useLayoutEffect(() => {
    const el = row.current!
    const chip = el.querySelector<HTMLElement>('[aria-checked=true]')!
    const start = parseFloat(getComputedStyle(el).paddingLeft)
    el.scrollLeft = Math.max(0, chip.offsetLeft - start)
    // Only the topic the screen opens on: a chip tapped later is in view.
  }, [])

  return (
    <div
      ref={row}
      role="radiogroup"
      aria-label="Topics"
      // The row spans the screen, so the topics scroll to its edges, but on
      // an iPad its padding starts them in line with the readable column.
      className="discover-chips relative flex gap-2 overflow-x-auto px-[max(16px,calc((100%-720px)/2+16px))] pb-3"
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
            className={`${PILL} whitespace-nowrap ${chipClass(checked)}`}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

// --- The feed -------------------------------------------------------------------

type FeedProps = Pick<
  Discover,
  'items' | 'status' | 'error' | 'hasMore' | 'loadMore' | 'refresh' | 'retry'
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
  retry,
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

  // Not under a failure's banner: Retry pages on from there.
  const more = hasMore && status !== 'error' && (
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
            onClick={() => void retry()}
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
          className="mx-4 mb-2 flex items-center gap-3 rounded-2xl bg-red-500/10 px-4 py-1 text-sm text-destructive"
        >
          <p className="min-w-0 flex-1">{error}</p>
          <button
            type="button"
            onClick={() => void retry()}
            className="min-h-11 shrink-0 touch-manipulation rounded-full px-3 font-semibold active:opacity-50"
          >
            Retry
          </button>
        </div>
      )}
      <DiscoverLeadCard item={lead} onOpen={onOpen} onSummarize={onSummarize} />
      {rest.length > 0 && (
        <ul aria-label="More stories">
          {rest.map((item, i) => (
            <DiscoverRow
              key={item.url}
              item={item}
              separator={i < rest.length - 1}
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
      className={`flex motion-safe:animate-pulse flex-col ${READABLE}`}
    >
      <div className="mx-4 mb-2 overflow-hidden rounded-2xl bg-muted">
        <div className="aspect-video max-h-[360px] w-full bg-foreground/8" />
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
