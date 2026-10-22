import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { createApiClient } from '@/core/api/client'
import type { DiscoverItem, Topic } from '@/features/discover/discover-api'
import {
  DISCOVER_CACHE_TTL_MS,
  DISCOVER_MAX_PAGE,
  resetDiscoverCache,
  useDiscover
} from '@/features/discover/useDiscover'

vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))

const BASE = 'https://ask.test.invalid'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

const blog = (url: string) => ({
  title: `Headline for ${url}`,
  content: `Summary of ${url}`,
  url,
  thumbnail: `${url}/thumb.jpg`
})

/** Three articles per page by default: https://<topic>.example/p<page>/<i>. */
const defaultPage = (topic: string, page: number) =>
  [0, 1, 2].map(i => blog(`https://${topic}.example/p${page}/${i}`))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => (resolve = r))
  return { promise, resolve }
}

type Handler = () => Response | Promise<Response>

// A fake /api/discover: per topic+page overrides, else defaultPage.
function fakeServer() {
  const overrides = new Map<string, Handler[]>()
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const topic = url.searchParams.get('topic')!
    const page = Number(url.searchParams.get('page'))
    const queue = overrides.get(`${topic}:${page}`)
    const handler = queue?.shift()
    if (handler) return handler()
    return json({ blogs: defaultPage(topic, page) })
  })
  return {
    fetchImpl,
    /** The next request for topic+page is answered by `handle`. */
    on(topic: string, page: number, handle: Handler) {
      const queue = overrides.get(`${topic}:${page}`) ?? []
      queue.push(handle)
      overrides.set(`${topic}:${page}`, queue)
    },
    /** The requests made so far, as "topic:page". */
    requests() {
      return fetchImpl.mock.calls.map(([input]) => {
        const url = new URL(String(input))
        return `${url.searchParams.get('topic')}:${url.searchParams.get('page')}`
      })
    }
  }
}

let server: ReturnType<typeof fakeServer>

function useServer() {
  server = fakeServer()
  // Signed out: the public route must not need a token.
  const getToken = vi.fn(async () => null)
  vi.mocked(useApi).mockReturnValue({
    client: createApiClient({
      baseUrl: BASE,
      getToken,
      fetchImpl: server.fetchImpl
    }),
    baseUrl: BASE,
    getToken
  } as Api)
}

function renderDiscover(topic: Topic = 'tech') {
  return renderHook(({ topic }) => useDiscover(topic), {
    initialProps: { topic }
  })
}

const urls = (items: DiscoverItem[]) => items.map(i => i.url)
const pageUrls = (topic: string, page: number) =>
  defaultPage(topic, page).map(b => b.url)

beforeEach(() => {
  resetDiscoverCache()
  vi.clearAllMocks()
  // Only Date is faked, so waitFor's timers still run.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-21T10:00:00Z'))
  useServer()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useDiscover', () => {
  it('loads page 1 of the topic, without a token, then is ready', async () => {
    const { result } = renderDiscover('science')
    expect(result.current.status).toBe('loading')
    expect(result.current.items).toEqual([])
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(urls(result.current.items)).toEqual(pageUrls('science', 1))
    expect(result.current.items[0].summary).toBe(
      'Summary of https://science.example/p1/0'
    )
    expect(result.current.hasMore).toBe(true)
    expect(result.current.error).toBeUndefined()
    expect(server.requests()).toEqual(['science:1'])
  })

  it('appends the next page on loadMore, deduped by url across pages', async () => {
    server.on('tech', 2, () =>
      json({
        blogs: [
          blog('https://tech.example/p1/1'), // already on page 1
          blog('https://tech.example/new'),
          blog('https://tech.example/new') // twice on this page
        ]
      })
    )
    const { result } = renderDiscover()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(() => result.current.loadMore())
    expect(urls(result.current.items)).toEqual([
      ...pageUrls('tech', 1),
      'https://tech.example/new'
    ])
    expect(result.current.hasMore).toBe(true)
    expect(server.requests()).toEqual(['tech:1', 'tech:2'])
  })

  it('stops after two pages with nothing new', async () => {
    // Pages 2 and 3 only repeat page 1.
    server.on('tech', 2, () => json({ blogs: defaultPage('tech', 1) }))
    server.on('tech', 3, () => json({ blogs: defaultPage('tech', 1) }))
    const { result } = renderDiscover()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(() => result.current.loadMore())
    expect(result.current.hasMore).toBe(true)
    await act(() => result.current.loadMore())
    expect(result.current.hasMore).toBe(false)
    expect(urls(result.current.items)).toEqual(pageUrls('tech', 1))
    await act(() => result.current.loadMore())
    expect(server.requests()).toEqual(['tech:1', 'tech:2', 'tech:3'])
  })

  it('a page of only duplicates followed by a page with new items keeps going', async () => {
    server.on('tech', 2, () => json({ blogs: defaultPage('tech', 1) }))
    server.on('tech', 4, () => json({ blogs: defaultPage('tech', 1) }))
    const { result } = renderDiscover()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(() => result.current.loadMore()) // 2: nothing new
    await act(() => result.current.loadMore()) // 3: new items
    await act(() => result.current.loadMore()) // 4: nothing new, once
    expect(result.current.hasMore).toBe(true)
    expect(urls(result.current.items)).toEqual([
      ...pageUrls('tech', 1),
      ...pageUrls('tech', 3)
    ])
    await act(() => result.current.loadMore())
    expect(server.requests()).toEqual([
      'tech:1',
      'tech:2',
      'tech:3',
      'tech:4',
      'tech:5'
    ])
  })

  it('an empty page 1 still tries page 2, then stops', async () => {
    server.on('tech', 1, () => json({ blogs: [] }))
    server.on('tech', 2, () => json({ blogs: [] }))
    const { result } = renderDiscover()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.items).toEqual([])
    expect(result.current.hasMore).toBe(true)
    await act(() => result.current.loadMore())
    expect(result.current.hasMore).toBe(false)
    expect(server.requests()).toEqual(['tech:1', 'tech:2'])
  })

  it('the run of pages with nothing new carries over a remount', async () => {
    server.on('tech', 2, () => json({ blogs: [] }))
    server.on('tech', 3, () => json({ blogs: [] }))
    const first = renderDiscover()
    await waitFor(() => expect(first.result.current.status).toBe('ready'))
    await act(() => first.result.current.loadMore())
    first.unmount()
    const { result } = renderDiscover()
    expect(result.current.hasMore).toBe(true)
    await act(() => result.current.loadMore())
    expect(result.current.hasMore).toBe(false)
    expect(server.requests()).toEqual(['tech:1', 'tech:2', 'tech:3'])
  })

  it('stops at page 10', async () => {
    expect(DISCOVER_MAX_PAGE).toBe(10)
    const { result } = renderDiscover()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    for (let page = 2; page <= 10; page++) {
      expect(result.current.hasMore).toBe(true)
      await act(() => result.current.loadMore())
    }
    expect(result.current.hasMore).toBe(false)
    await act(() => result.current.loadMore())
    expect(server.requests()).toHaveLength(10)
    expect(server.requests().at(-1)).toBe('tech:10')
    expect(result.current.items).toHaveLength(30)
  })

  it('runs one loadMore at a time, and none while page 1 loads', async () => {
    const first = deferred<Response>()
    server.on('tech', 1, () => first.promise)
    const { result } = renderDiscover()
    await act(() => result.current.loadMore())
    expect(server.requests()).toEqual(['tech:1'])
    await act(async () =>
      first.resolve(json({ blogs: defaultPage('tech', 1) }))
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))

    const second = deferred<Response>()
    server.on('tech', 2, () => second.promise)
    let a!: Promise<void>
    let b!: Promise<void>
    act(() => {
      a = result.current.loadMore()
      b = result.current.loadMore()
    })
    await act(async () => {
      second.resolve(json({ blogs: defaultPage('tech', 2) }))
      await Promise.all([a, b])
    })
    expect(server.requests()).toEqual(['tech:1', 'tech:2'])
    expect(result.current.items).toHaveLength(6)
  })

  it('asks nothing on loadMore while a refresh is loading', async () => {
    const { result } = renderDiscover()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const fresh = deferred<Response>()
    server.on('tech', 1, () => fresh.promise)
    let done!: Promise<void>
    act(() => {
      done = result.current.refresh()
    })
    expect(result.current.status).toBe('refreshing')
    await act(() => result.current.loadMore())
    await act(async () => {
      fresh.resolve(json({ blogs: [blog('https://tech.example/fresh')] }))
      await done
    })
    expect(server.requests()).toEqual(['tech:1', 'tech:1'])
    expect(urls(result.current.items)).toEqual(['https://tech.example/fresh'])
  })

  describe('per-topic cache', () => {
    it('shows a topic loaded within 15 minutes at once, with its pages, and asks nothing', async () => {
      const first = renderDiscover()
      await waitFor(() => expect(first.result.current.status).toBe('ready'))
      await act(() => first.result.current.loadMore())
      first.unmount()

      vi.setSystemTime(Date.now() + DISCOVER_CACHE_TTL_MS - 1)
      const { result } = renderDiscover()
      expect(result.current.status).toBe('ready')
      expect(urls(result.current.items)).toEqual([
        ...pageUrls('tech', 1),
        ...pageUrls('tech', 2)
      ])
      expect(server.requests()).toEqual(['tech:1', 'tech:2'])
      // It carries on from the next page.
      await act(() => result.current.loadMore())
      expect(server.requests()).toEqual(['tech:1', 'tech:2', 'tech:3'])
    })

    it('switches back and forth between topics instantly', async () => {
      const { result, rerender } = renderDiscover('tech')
      await waitFor(() => expect(result.current.status).toBe('ready'))
      rerender({ topic: 'world' })
      await waitFor(() =>
        expect(urls(result.current.items)).toEqual(pageUrls('world', 1))
      )
      rerender({ topic: 'tech' })
      expect(result.current.status).toBe('ready')
      expect(urls(result.current.items)).toEqual(pageUrls('tech', 1))
      expect(server.requests()).toEqual(['tech:1', 'world:1'])
    })

    it('refetches page 1 after 15 minutes, showing the old items meanwhile', async () => {
      const first = renderDiscover()
      await waitFor(() => expect(first.result.current.status).toBe('ready'))
      first.unmount()

      vi.setSystemTime(Date.now() + DISCOVER_CACHE_TTL_MS)
      const fresh = deferred<Response>()
      server.on('tech', 1, () => fresh.promise)
      const { result } = renderDiscover()
      expect(result.current.status).toBe('refreshing')
      expect(urls(result.current.items)).toEqual(pageUrls('tech', 1))
      await act(async () =>
        fresh.resolve(json({ blogs: [blog('https://tech.example/fresh')] }))
      )
      await waitFor(() => expect(result.current.status).toBe('ready'))
      expect(urls(result.current.items)).toEqual(['https://tech.example/fresh'])
      expect(server.requests()).toEqual(['tech:1', 'tech:1'])
    })

    it('refresh bypasses the cache and starts the topic again from page 1', async () => {
      const { result } = renderDiscover()
      await waitFor(() => expect(result.current.status).toBe('ready'))
      await act(() => result.current.loadMore())

      const fresh = deferred<Response>()
      server.on('tech', 1, () => fresh.promise)
      let done!: Promise<void>
      act(() => {
        done = result.current.refresh()
      })
      expect(result.current.status).toBe('refreshing')
      expect(result.current.items).toHaveLength(6)
      await act(async () => {
        fresh.resolve(json({ blogs: [blog('https://tech.example/fresh')] }))
        await done
      })
      expect(result.current.status).toBe('ready')
      expect(urls(result.current.items)).toEqual(['https://tech.example/fresh'])
      await act(() => result.current.loadMore())
      expect(server.requests()).toEqual([
        'tech:1',
        'tech:2',
        'tech:1',
        'tech:2'
      ])
    })

    it('a refreshed list is what the next mount shows', async () => {
      const first = renderDiscover()
      await waitFor(() => expect(first.result.current.status).toBe('ready'))
      server.on('tech', 1, () =>
        json({ blogs: [blog('https://tech.example/r')] })
      )
      await act(() => first.result.current.refresh())
      first.unmount()
      const { result } = renderDiscover()
      expect(result.current.status).toBe('ready')
      expect(urls(result.current.items)).toEqual(['https://tech.example/r'])
    })
  })

  describe('latest wins', () => {
    it('drops page 1 of a topic switched away from, and does not cache it', async () => {
      const stale = deferred<Response>()
      server.on('tech', 1, () => stale.promise)
      const { result, rerender } = renderDiscover('tech')
      rerender({ topic: 'world' })
      await waitFor(() => expect(result.current.status).toBe('ready'))
      expect(urls(result.current.items)).toEqual(pageUrls('world', 1))

      await act(async () =>
        stale.resolve(json({ blogs: [blog('https://tech.example/stale')] }))
      )
      expect(urls(result.current.items)).toEqual(pageUrls('world', 1))
      expect(result.current.status).toBe('ready')

      // Back on tech, nothing was cached for it: it loads afresh.
      rerender({ topic: 'tech' })
      expect(result.current.status).toBe('loading')
      expect(result.current.items).toEqual([])
      await waitFor(() => expect(result.current.status).toBe('ready'))
      expect(urls(result.current.items)).toEqual(pageUrls('tech', 1))
      expect(server.requests()).toEqual(['tech:1', 'world:1', 'tech:1'])
    })

    it('drops a page of a topic switched away from', async () => {
      const { result, rerender } = renderDiscover('tech')
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const stale = deferred<Response>()
      server.on('tech', 2, () => stale.promise)
      let more!: Promise<void>
      act(() => {
        more = result.current.loadMore()
      })
      rerender({ topic: 'world' })
      await waitFor(() => expect(result.current.status).toBe('ready'))
      await act(async () => {
        stale.resolve(json({ blogs: defaultPage('tech', 2) }))
        await more
      })
      expect(urls(result.current.items)).toEqual(pageUrls('world', 1))
      // World's own next page is not held up by tech's.
      await act(() => result.current.loadMore())
      expect(server.requests()).toEqual([
        'tech:1',
        'tech:2',
        'world:1',
        'world:2'
      ])
    })

    it("a dropped page does not let the new topic's page run twice", async () => {
      const { result, rerender } = renderDiscover('tech')
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const stale = deferred<Response>()
      server.on('tech', 2, () => stale.promise)
      let staleMore!: Promise<void>
      act(() => {
        staleMore = result.current.loadMore()
      })
      rerender({ topic: 'world' })
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const worldPage = deferred<Response>()
      server.on('world', 2, () => worldPage.promise)
      let worldMore!: Promise<void>
      act(() => {
        worldMore = result.current.loadMore()
      })
      await act(async () => {
        stale.resolve(json({ blogs: defaultPage('tech', 2) }))
        await staleMore
      })
      // World's page 2 is still loading: a second loadMore asks nothing.
      await act(async () => {
        const again = result.current.loadMore()
        worldPage.resolve(json({ blogs: defaultPage('world', 2) }))
        await Promise.all([again, worldMore])
      })
      expect(server.requests()).toEqual([
        'tech:1',
        'tech:2',
        'world:1',
        'world:2'
      ])
      expect(result.current.items).toHaveLength(6)
    })

    it("a loadMore kept from an earlier topic's render does nothing", async () => {
      const { result, rerender } = renderDiscover('tech')
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const techLoadMore = result.current.loadMore
      rerender({ topic: 'world' })
      await waitFor(() => expect(result.current.status).toBe('ready'))
      await act(() => techLoadMore())
      expect(server.requests()).toEqual(['tech:1', 'world:1'])
      expect(urls(result.current.items)).toEqual(pageUrls('world', 1))
    })

    it('drops a failure of a topic switched away from', async () => {
      const stale = deferred<Response>()
      server.on('tech', 1, () => stale.promise)
      const { result, rerender } = renderDiscover('tech')
      rerender({ topic: 'world' })
      await waitFor(() => expect(result.current.status).toBe('ready'))
      await act(async () => stale.resolve(json({ message: 'boom' }, 500)))
      expect(result.current.status).toBe('ready')
      expect(result.current.error).toBeUndefined()
    })

    it('drops a failed page of a topic switched away from', async () => {
      const { result, rerender } = renderDiscover('tech')
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const stale = deferred<Response>()
      server.on('tech', 2, () => stale.promise)
      let more!: Promise<void>
      act(() => {
        more = result.current.loadMore()
      })
      rerender({ topic: 'world' })
      await waitFor(() => expect(result.current.status).toBe('ready'))
      await act(async () => {
        stale.resolve(json({ message: 'boom' }, 500))
        await more
      })
      expect(result.current.status).toBe('ready')
      expect(result.current.error).toBeUndefined()
    })

    it("never shows another topic's items, even for one render", async () => {
      // Every render, as the topic it was for and the urls it returned.
      const renders: Array<{ topic: Topic; urls: string[] }> = []
      const { result, rerender } = renderHook(
        ({ topic }: { topic: Topic }) => {
          const discover = useDiscover(topic)
          renders.push({ topic, urls: urls(discover.items) })
          return discover
        },
        { initialProps: { topic: 'tech' as Topic } }
      )
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const pending = deferred<Response>()
      server.on('world', 1, () => pending.promise)
      rerender({ topic: 'world' })
      expect(result.current.status).toBe('loading')
      await act(async () => pending.resolve(json({ blogs: [] })))
      const worldRenders = renders.filter(r => r.topic === 'world')
      expect(worldRenders.length).toBeGreaterThan(0)
      expect(worldRenders.every(r => r.urls.length === 0)).toBe(true)
    })

    it('drops a request when switching to a topic shown from the cache', async () => {
      const { result, rerender } = renderDiscover('tech')
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const stale = deferred<Response>()
      server.on('world', 1, () => stale.promise)
      rerender({ topic: 'world' })
      rerender({ topic: 'tech' }) // fresh in the cache: no request
      await act(async () =>
        stale.resolve(json({ blogs: defaultPage('world', 1) }))
      )
      expect(result.current.status).toBe('ready')
      expect(urls(result.current.items)).toEqual(pageUrls('tech', 1))
      // Tech's list is still the one in use, and world was not cached.
      await act(() => result.current.loadMore())
      rerender({ topic: 'world' })
      expect(result.current.status).toBe('loading')
      await waitFor(() => expect(result.current.status).toBe('ready'))
      expect(server.requests()).toEqual([
        'tech:1',
        'world:1',
        'tech:2',
        'world:1'
      ])
    })
  })

  describe('errors', () => {
    it('a failed page keeps the items loaded; loadMore retries it', async () => {
      server.on('tech', 2, () => json({ message: 'boom' }, 500))
      const { result } = renderDiscover()
      await waitFor(() => expect(result.current.status).toBe('ready'))
      await act(() => result.current.loadMore())
      expect(result.current.status).toBe('error')
      expect(result.current.error).toBe('Request failed (500)')
      expect(urls(result.current.items)).toEqual(pageUrls('tech', 1))
      expect(result.current.hasMore).toBe(true)

      await act(() => result.current.loadMore())
      expect(result.current.status).toBe('ready')
      expect(result.current.error).toBeUndefined()
      expect(urls(result.current.items)).toEqual([
        ...pageUrls('tech', 1),
        ...pageUrls('tech', 2)
      ])
      expect(server.requests()).toEqual(['tech:1', 'tech:2', 'tech:2'])
    })

    it('a failed refresh keeps the items shown', async () => {
      const { result } = renderDiscover()
      await waitFor(() => expect(result.current.status).toBe('ready'))
      server.on('tech', 1, () => {
        throw new TypeError('offline')
      })
      await act(() => result.current.refresh())
      expect(result.current.status).toBe('error')
      expect(result.current.error).toBe('Network error. Check your connection.')
      expect(urls(result.current.items)).toEqual(pageUrls('tech', 1))
    })

    it('a failed page 1 is an error with no items; loadMore waits for refresh', async () => {
      server.on('tech', 1, () => json({ message: 'boom' }, 500))
      const { result } = renderDiscover()
      await waitFor(() => expect(result.current.status).toBe('error'))
      expect(result.current.items).toEqual([])
      await act(() => result.current.loadMore())
      expect(server.requests()).toEqual(['tech:1'])

      await act(() => result.current.refresh())
      expect(result.current.status).toBe('ready')
      expect(result.current.error).toBeUndefined()
      expect(urls(result.current.items)).toEqual(pageUrls('tech', 1))
    })
  })

  describe('retry', () => {
    it('after a failed next page asks for that page again, not page 1', async () => {
      server.on('tech', 2, () => json({ message: 'boom' }, 500))
      const { result } = renderDiscover()
      await waitFor(() => expect(result.current.status).toBe('ready'))
      await act(() => result.current.loadMore())
      expect(result.current.status).toBe('error')

      const page2 = deferred<Response>()
      server.on('tech', 2, () => page2.promise)
      let retried!: Promise<void>
      act(() => {
        retried = result.current.retry()
      })
      // The failure is no longer shown while the page loads again.
      expect(result.current.status).toBe('ready')
      expect(result.current.error).toBeUndefined()
      await act(async () => {
        page2.resolve(json({ blogs: defaultPage('tech', 2) }))
        await retried
      })
      expect(urls(result.current.items)).toEqual([
        ...pageUrls('tech', 1),
        ...pageUrls('tech', 2)
      ])
      expect(server.requests()).toEqual(['tech:1', 'tech:2', 'tech:2'])
    })

    it('shows the failure again when the retried page fails too', async () => {
      server.on('tech', 2, () => json({ message: 'boom' }, 500))
      server.on('tech', 2, () => json({ message: 'boom' }, 502))
      const { result } = renderDiscover()
      await waitFor(() => expect(result.current.status).toBe('ready'))
      await act(() => result.current.loadMore())
      await act(() => result.current.retry())
      expect(result.current.status).toBe('error')
      expect(result.current.error).toBe('Request failed (502)')
      expect(server.requests()).toEqual(['tech:1', 'tech:2', 'tech:2'])
    })

    it('after a failed page 1 asks for page 1 again', async () => {
      server.on('tech', 1, () => json({ message: 'boom' }, 500))
      const { result } = renderDiscover()
      await waitFor(() => expect(result.current.status).toBe('error'))
      await act(() => result.current.retry())
      expect(result.current.status).toBe('ready')
      expect(urls(result.current.items)).toEqual(pageUrls('tech', 1))
      expect(server.requests()).toEqual(['tech:1', 'tech:1'])
    })

    it('after a failed refresh of a loaded list starts again from page 1', async () => {
      const { result } = renderDiscover()
      await waitFor(() => expect(result.current.status).toBe('ready'))
      await act(() => result.current.loadMore())
      server.on('tech', 1, () => json({ message: 'boom' }, 500))
      await act(() => result.current.refresh())
      expect(result.current.status).toBe('error')

      await act(() => result.current.retry())
      expect(result.current.status).toBe('ready')
      expect(urls(result.current.items)).toEqual(pageUrls('tech', 1))
      expect(server.requests()).toEqual([
        'tech:1',
        'tech:2',
        'tech:1',
        'tech:1'
      ])
    })

    it('retries the latest failure: a failed refresh after a failed page', async () => {
      server.on('tech', 2, () => json({ message: 'boom' }, 500))
      const { result } = renderDiscover()
      await waitFor(() => expect(result.current.status).toBe('ready'))
      await act(() => result.current.loadMore())
      server.on('tech', 1, () => json({ message: 'boom' }, 500))
      await act(() => result.current.refresh())

      await act(() => result.current.retry())
      expect(server.requests()).toEqual([
        'tech:1',
        'tech:2',
        'tech:1',
        'tech:1'
      ])
      expect(urls(result.current.items)).toEqual(pageUrls('tech', 1))
    })

    it('after a failed page loaded nothing yet, asks for that page again', async () => {
      server.on('tech', 1, () => json({ blogs: [] }))
      server.on('tech', 2, () => json({ message: 'boom' }, 500))
      const { result } = renderDiscover()
      await waitFor(() => expect(result.current.status).toBe('ready'))
      await act(() => result.current.loadMore())
      expect(result.current.status).toBe('error')
      expect(result.current.items).toEqual([])

      await act(() => result.current.retry())
      expect(urls(result.current.items)).toEqual(pageUrls('tech', 2))
      expect(server.requests()).toEqual(['tech:1', 'tech:2', 'tech:2'])
    })
  })
})
