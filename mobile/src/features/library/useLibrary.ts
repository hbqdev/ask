// The Library's state: the user's chat history, paged and sorted, shown from
// the per-user cache at once and revalidated from the server; optimistic
// remove and rename; and the history search box.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'

import { useApi } from '@/core/api/ApiProvider'
import { ApiError } from '@/core/api/errors'
import { useAuth } from '@/core/auth/AuthProvider'
import { onChatsChanged } from '@/core/chats-events'
import {
  deleteChat,
  fetchChatsPage,
  renameChat,
  searchChats,
  type ChatRow,
  type ChatSort,
  type SearchHit
} from '@/features/library/library-api'
import {
  loadLibraryCache,
  saveLibraryCache
} from '@/features/library/library-cache'

export type LibraryStatus = 'loading' | 'ready' | 'refreshing' | 'error'

export type Library = {
  chats: ChatRow[]
  total?: number
  status: LibraryStatus
  error?: string
  hasMore: boolean
  loadMore(): Promise<void>
  refresh(): Promise<void>
  /** Optimistic; restores the row and sets `error` on failure. */
  remove(id: string): Promise<boolean>
  /** Optimistic; reverts the title and sets `error` on failure. */
  rename(id: string, title: string): Promise<boolean>
}

/** The list for one user and sort; rows never outlive that pair. */
type ListState = {
  key: string
  /** The page-0 load that produced this list; -1 for none yet. */
  gen: number
  chats: ChatRow[]
  total?: number
  nextOffset: number | null
  status: LibraryStatus
  error?: string
}

const emptyList = (key: string): ListState => ({
  key,
  gen: -1,
  chats: [],
  nextOffset: null,
  status: 'loading'
})

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const addTo = (total: number | undefined, n: number) =>
  total === undefined ? undefined : total + n

export function useLibrary({ sort }: { sort: ChatSort }): Library {
  const { client } = useApi()
  const userId = useAuth().session?.user.id
  const key = `${userId ?? ''}\n${sort}`

  const [state, setState] = useState<ListState>(() => emptyList(key))
  const stateRef = useRef(state)
  useLayoutEffect(() => {
    stateRef.current = state
  })

  // Bumped by every page-0 load: a page from an older generation is dropped.
  const generation = useRef(0)
  // The generation of the page now loading, if any. A page dropped by a
  // newer generation does not hold up the next loadMore.
  const loadingMoreIn = useRef<number | null>(null)
  // Set when loadMore is asked for while the shown (committed) list is not
  // the current generation's: page 0 is loading, or has landed but is not yet
  // committed. That list's next offset belongs to the list being replaced, so
  // the page runs once the new list is committed. A newer page 0 or a failed
  // page 0 drops the request.
  const moreWanted = useRef(false)
  // Offsets after removes: whenever it is unknown whether the server had
  // applied a delete when it ran a page query, assume it had not and ask for
  // a smaller offset. A repeat is dropped as a duplicate; a skip would lose a
  // chat. So a page starts `pendingRemoves` earlier, and its next offset moves
  // back by every remove that succeeded while it was loading.
  const pendingRemoves = useRef(0)
  const removals = useRef(0)
  // Rows removed here (pending or done), kept out of any page that raced it.
  const removed = useRef(new Set<string>())

  const loadFirstPage = useCallback(async () => {
    const mine = ++generation.current
    moreWanted.current = false
    // Signed out: nothing to show and nothing to ask the server for.
    if (!userId) {
      setState({ key, gen: mine, chats: [], nextOffset: null, status: 'ready' })
      return
    }
    setState(s =>
      s.key === key
        ? { ...s, status: s.chats.length ? 'refreshing' : 'loading' }
        : emptyList(key)
    )
    try {
      const page = await fetchChatsPage(client, {
        offset: 0,
        sort,
        withCount: true
      })
      if (mine !== generation.current) return
      setState({
        key,
        gen: mine,
        chats: page.chats.filter(c => !removed.current.has(c.id)),
        total: page.total,
        nextOffset: page.nextOffset,
        status: 'ready'
      })
    } catch (error) {
      if (mine !== generation.current) return
      // The list did not change: it stays, now as this generation's, and a
      // page wanted meanwhile is not loaded.
      moreWanted.current = false
      setState(s => ({
        ...s,
        gen: mine,
        status: 'error',
        error: errorMessage(error)
      }))
    }
  }, [client, key, sort, userId])

  // A new user or sort: start over, show the cache when it comes, revalidate.
  useEffect(() => {
    setState(emptyList(key))
    void loadFirstPage()
    if (!userId) return
    void loadLibraryCache(userId).then(cache => {
      if (!cache || cache.sort !== sort) return
      // Only while the server has not answered with rows of its own.
      setState(s =>
        s.key === key && s.chats.length === 0 && s.status !== 'ready'
          ? {
              ...s,
              chats: cache.chats,
              total: cache.total,
              status: s.status === 'loading' ? 'refreshing' : s.status
            }
          : s
      )
    })
  }, [key, userId, sort, loadFirstPage])

  // Changes made on another screen. Only a created or cleared list reloads
  // page 0; the rest change the loaded rows in place, as a page-0 reload
  // would drop the loaded pages (and the scroll). A change to a row that is
  // not loaded is left to the next load.

  // A chat opened or answered elsewhere: its view time is now, which moves it
  // to the top in `recent`, as the server now orders it.
  const markViewed = useCallback(
    (id: string) => {
      setState(s => {
        const index = s.chats.findIndex(c => c.id === id)
        if (index < 0) return s
        const viewed = {
          ...s.chats[index],
          lastViewedAt: new Date().toISOString()
        }
        const chats =
          sort === 'recent'
            ? [viewed, ...s.chats.filter(c => c.id !== id)]
            : s.chats.map(c => (c.id === id ? viewed : c))
        return { ...s, chats }
      })
    },
    [sort]
  )

  const retitleLoaded = useCallback((id: string, title: string) => {
    setState(s =>
      s.chats.some(c => c.id === id)
        ? {
            ...s,
            chats: s.chats.map(c => (c.id === id ? { ...c, title } : c))
          }
        : s
    )
  }, [])

  // Already deleted on the server: the same bookkeeping as a remove here
  // that succeeded, so the next page neither skips nor repeats a row.
  const dropDeleted = useCallback((id: string) => {
    if (!stateRef.current.chats.some(c => c.id === id)) return
    removed.current.add(id)
    removals.current += 1
    setState(s => ({
      ...s,
      chats: s.chats.filter(c => c.id !== id),
      total: addTo(s.total, -1),
      nextOffset: s.nextOffset === null ? null : s.nextOffset - 1
    }))
  }, [])

  useEffect(
    () =>
      onChatsChanged((reason, chatId, detail) => {
        if (reason === 'created' || reason === 'cleared') {
          return void loadFirstPage()
        }
        if (!chatId) return
        if (reason === 'renamed') {
          if (detail?.title) retitleLoaded(chatId, detail.title)
        } else if (reason === 'deleted') dropDeleted(chatId)
        else markViewed(chatId)
      }),
    [loadFirstPage, markViewed, retitleLoaded, dropDeleted]
  )

  // Server-confirmed rows (status ready) go to the signed-in user's cache.
  useEffect(() => {
    if (!userId || state.key !== key || state.status !== 'ready') return
    void saveLibraryCache(userId, {
      sort,
      chats: state.chats,
      total: state.total
    })
  }, [state, key, userId, sort])

  const loadMore = useCallback(async () => {
    // Only the committed list of the current generation gives the offset.
    const { key: listKey, gen, nextOffset } = stateRef.current
    const mine = generation.current
    if (gen !== mine) {
      moreWanted.current = true
      return
    }
    if (
      listKey !== key ||
      nextOffset === null ||
      loadingMoreIn.current === mine
    )
      return
    loadingMoreIn.current = mine
    const removalsBefore = removals.current
    try {
      const page = await fetchChatsPage(client, {
        offset: Math.max(0, nextOffset - pendingRemoves.current),
        sort
      })
      if (mine !== generation.current) return
      const shift = removals.current - removalsBefore
      setState(s => {
        const have = new Set(s.chats.map(c => c.id))
        const fresh = page.chats.filter(
          c => !have.has(c.id) && !removed.current.has(c.id)
        )
        return {
          ...s,
          chats: [...s.chats, ...fresh],
          nextOffset: page.nextOffset === null ? null : page.nextOffset - shift,
          status: 'ready',
          error: undefined
        }
      })
    } catch (error) {
      if (mine !== generation.current) return
      setState(s => ({ ...s, status: 'error', error: errorMessage(error) }))
    } finally {
      if (loadingMoreIn.current === mine) loadingMoreIn.current = null
    }
  }, [client, key, sort])

  const remove = useCallback(
    async (id: string) => {
      const before = stateRef.current
      const index = before.chats.findIndex(c => c.id === id)
      if (index < 0) return false
      const row = before.chats[index]
      removed.current.add(id)
      setState(s => ({
        ...s,
        chats: s.chats.filter(c => c.id !== id),
        total: addTo(s.total, -1)
      }))
      pendingRemoves.current += 1
      try {
        await deleteChat(client, id)
      } catch (error) {
        // Already gone on the server: that is what the user wanted.
        if (!(error instanceof ApiError && error.status === 404)) {
          removed.current.delete(id)
          setState(s => {
            // The list is now another user's or sort's: never put it there.
            if (s.key !== before.key) {
              return { ...s, error: errorMessage(error) }
            }
            const chats = [...s.chats]
            chats.splice(Math.min(index, chats.length), 0, row)
            return {
              ...s,
              chats,
              total: addTo(s.total, 1),
              error: errorMessage(error)
            }
          })
          return false
        }
      } finally {
        pendingRemoves.current -= 1
      }
      removals.current += 1
      // Also on a list that replaced the one this row was in: its page 0 may
      // have been read before the delete landed (see pendingRemoves).
      setState(s =>
        s.nextOffset === null ? s : { ...s, nextOffset: s.nextOffset - 1 }
      )
      return true
    },
    [client]
  )

  const rename = useCallback(
    async (id: string, title: string) => {
      const row = stateRef.current.chats.find(c => c.id === id)
      if (!row) return false
      const next = title.trim()
      if (!next) {
        setState(s => ({ ...s, error: 'Title is required' }))
        return false
      }
      // Moves the row's title from `from` to `to`, unless something else
      // changed it meanwhile.
      const retitle = (from: string, to: string, error?: string) =>
        setState(s => ({
          ...s,
          chats: s.chats.map(c =>
            c.id === id && c.title === from ? { ...c, title: to } : c
          ),
          ...(error ? { error } : {})
        }))
      retitle(row.title, next)
      try {
        retitle(next, await renameChat(client, id, next))
        return true
      } catch (error) {
        retitle(next, row.title, errorMessage(error))
        return false
      }
    },
    [client]
  )

  // A wanted loadMore runs once the current generation's list is committed.
  useEffect(() => {
    if (!moreWanted.current || state.gen !== generation.current) return
    if (state.status !== 'ready') return
    moreWanted.current = false
    void loadMore()
  }, [state, loadMore])

  // Rows from another user or sort are never shown, even for one render.
  const current = state.key === key ? state : emptyList(key)
  return {
    chats: current.chats,
    total: current.total,
    status: current.status,
    error: current.error,
    hasMore: current.nextOffset !== null,
    loadMore,
    refresh: loadFirstPage,
    remove,
    rename
  }
}

// --- Search -------------------------------------------------------------------

export type ChatSearchStatus = 'idle' | 'searching' | 'ready' | 'error'

/** Typing pauses this long before a keyword search runs. */
export const SEARCH_DEBOUNCE_MS = 300

export type ChatSearch = {
  query: string
  setQuery(query: string): void
  results: SearchHit[]
  status: ChatSearchStatus
  /** Searches the current query at once, with semantic recall. */
  submit(): void
}

/**
 * The history search box: keyword search 300 ms after typing stops, semantic
 * on submit. Each search aborts the one before it, and only the latest one's
 * answer is shown. An empty query clears the results.
 */
export function useChatSearch(): ChatSearch {
  const { client } = useApi()
  const [query, setQueryState] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [status, setStatus] = useState<ChatSearchStatus>('idle')
  const queryRef = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inFlight = useRef<AbortController | null>(null)

  const cancel = useCallback(() => {
    clearTimeout(timer.current)
    inFlight.current?.abort()
    inFlight.current = null
  }, [])

  const clear = useCallback(() => {
    cancel()
    setResults([])
    setStatus('idle')
  }, [cancel])

  const run = useCallback(
    (q: string, semantic: boolean) => {
      cancel()
      const controller = new AbortController()
      inFlight.current = controller
      setStatus('searching')
      searchChats(client, q, { semantic, signal: controller.signal }).then(
        hits => {
          if (inFlight.current !== controller) return
          inFlight.current = null
          setResults(hits)
          setStatus('ready')
        },
        () => {
          if (inFlight.current !== controller) return
          inFlight.current = null
          setStatus('error')
        }
      )
    },
    [client, cancel]
  )

  const setQuery = useCallback(
    (next: string) => {
      queryRef.current = next
      setQueryState(next)
      const q = next.trim()
      if (!q) return clear()
      cancel()
      timer.current = setTimeout(() => run(q, false), SEARCH_DEBOUNCE_MS)
    },
    [cancel, clear, run]
  )

  const submit = useCallback(() => {
    const q = queryRef.current.trim()
    if (!q) return clear()
    run(q, true)
  }, [clear, run])

  useEffect(() => cancel, [cancel])

  return { query, setQuery, results, status, submit }
}
