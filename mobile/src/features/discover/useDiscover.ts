// Discover's state for one topic: its articles page by page (1..10), deduped
// by url, from a per-topic in-memory cache when that is under 15 minutes old
// so switching topics (or screens) back and forth is instant. Only the
// current topic's answers are used: a topic switch or refresh drops every
// request made before it.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'

import { useApi } from '@/core/api/ApiProvider'
import {
  fetchDiscoverPage,
  type DiscoverItem,
  type Topic
} from '@/features/discover/discover-api'

export type DiscoverStatus = 'loading' | 'ready' | 'refreshing' | 'error'

export type Discover = {
  items: DiscoverItem[]
  status: DiscoverStatus
  error?: string
  hasMore: boolean
  /** Appends the next page; a no-op while page 1 loads or a page is loading. */
  loadMore(): Promise<void>
  /** Loads the topic again from page 1, whatever the cache holds. */
  refresh(): Promise<void>
}

// Each page costs the server ~12 SearXNG queries plus degoog, so paging stops
// where the web's Discover does (app/discover/page.tsx): at page 10, degoog's
// own limit, or after 2 pages in a row that add nothing new.
export const DISCOVER_MAX_PAGE = 10
export const DISCOVER_MAX_EMPTY_PAGES = 2
export const DISCOVER_CACHE_TTL_MS = 15 * 60_000

/** A topic's loaded pages. */
type TopicList = {
  items: DiscoverItem[]
  /** The page loadMore asks for next. */
  nextPage: number
  hasMore: boolean
  /** How many pages in a row, up to the last, added no new item. */
  emptyStreak: number
  /** When page 1 of this list was fetched; 0 for none. */
  fetchedAt: number
}

// Module-level, so it survives remounts for the app session. Public news
// only: nothing here is per-user.
const cache = new Map<Topic, TopicList>()

/** Empties the cache (for tests). */
export function resetDiscoverCache(): void {
  cache.clear()
}

type State = TopicList & {
  topic: Topic
  status: DiscoverStatus
  error?: string
}

/** What a topic shows before any request: its cached list, if any. */
function initialState(topic: Topic): State {
  const hit = cache.get(topic)
  if (!hit) {
    return {
      topic,
      items: [],
      nextPage: 1,
      hasMore: true,
      emptyStreak: 0,
      fetchedAt: 0,
      status: 'loading'
    }
  }
  const fresh = Date.now() - hit.fetchedAt < DISCOVER_CACHE_TTL_MS
  return { ...hit, topic, status: fresh ? 'ready' : 'refreshing' }
}

/**
 * `base` with page `page`'s items added, minus urls already there (or
 * repeated), and whether another page is worth asking for.
 */
function withPage(
  base: Pick<TopicList, 'items' | 'emptyStreak' | 'fetchedAt'>,
  page: number,
  pageItems: DiscoverItem[]
): TopicList {
  const seen = new Set(base.items.map(item => item.url))
  const added = pageItems.filter(item => {
    if (seen.has(item.url)) return false
    seen.add(item.url)
    return true
  })
  const emptyStreak = added.length ? 0 : base.emptyStreak + 1
  return {
    items: [...base.items, ...added],
    nextPage: page + 1,
    hasMore: emptyStreak < DISCOVER_MAX_EMPTY_PAGES && page < DISCOVER_MAX_PAGE,
    emptyStreak,
    fetchedAt: base.fetchedAt
  }
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export function useDiscover(topic: Topic): Discover {
  const { client } = useApi()
  const [state, setState] = useState<State>(() => initialState(topic))
  const stateRef = useRef(state)
  useLayoutEffect(() => {
    stateRef.current = state
  })

  // Bumped by every topic switch and page-1 load: an answer to a request
  // from an older generation is dropped.
  const generation = useRef(0)
  // The generation whose loadMore is in flight, if any.
  const loadingMoreIn = useRef<number | null>(null)

  /** Commits a list as the topic's, in the state and the cache. */
  const commit = useCallback(
    (list: TopicList) => {
      cache.set(topic, list)
      setState({ ...list, topic, status: 'ready' })
    },
    [topic]
  )

  const loadFirstPage = useCallback(async () => {
    const mine = ++generation.current
    setState(s => ({
      ...s,
      status: s.items.length ? 'refreshing' : 'loading',
      error: undefined
    }))
    try {
      const page = await fetchDiscoverPage(client, topic, 1)
      if (mine !== generation.current) return
      const fresh = { items: [], emptyStreak: 0, fetchedAt: Date.now() }
      commit(withPage(fresh, 1, page))
    } catch (error) {
      if (mine !== generation.current) return
      setState(s => ({ ...s, status: 'error', error: errorMessage(error) }))
    }
  }, [client, topic, commit])

  // A new topic: show its cache at once, and load page 1 unless that is fresh.
  useEffect(() => {
    generation.current += 1
    const start = initialState(topic)
    setState(start)
    if (start.status !== 'ready') void loadFirstPage()
  }, [topic, loadFirstPage])

  const loadMore = useCallback(async () => {
    const base = stateRef.current
    const mine = generation.current
    // Only a loaded list of this topic is extended (a loadMore kept from
    // an earlier topic's render does nothing): page 1 comes from refresh or
    // the topic switch, never from here, and so is never 'loading' here.
    if (
      base.topic !== topic ||
      base.nextPage === 1 ||
      !base.hasMore ||
      base.status === 'refreshing' ||
      loadingMoreIn.current === mine
    )
      return
    loadingMoreIn.current = mine
    try {
      const page = await fetchDiscoverPage(client, topic, base.nextPage)
      if (mine !== generation.current) return
      commit(withPage(base, base.nextPage, page))
    } catch (error) {
      if (mine !== generation.current) return
      setState(s => ({ ...s, status: 'error', error: errorMessage(error) }))
    } finally {
      if (loadingMoreIn.current === mine) loadingMoreIn.current = null
    }
  }, [client, topic, commit])

  // Another topic's items are never shown, even for one render.
  const current = state.topic === topic ? state : initialState(topic)
  return {
    items: current.items,
    status: current.status,
    error: current.error,
    hasMore: current.hasMore,
    loadMore,
    refresh: loadFirstPage
  }
}
