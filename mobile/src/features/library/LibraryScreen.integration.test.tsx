// The Library screen over the real useLibrary and useChatSearch, with a fake
// Ask server behind the real API client.

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { createApiClient } from '@/core/api/client'
import { useAuth, type Auth } from '@/core/auth/AuthProvider'
import { StackProvider } from '@/core/nav/stack'
import { saveLibraryCache } from '@/features/library/library-cache'
import type { ChatRow } from '@/features/library/library-api'
import { LIBRARY_SORT_KEY } from '@/features/library/library-sort'
import { LibraryScreen } from '@/features/library/LibraryScreen'

vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/core/auth/AuthProvider', () => ({ useAuth: vi.fn() }))

const prefsData = vi.hoisted(() => new Map<string, string>())
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: prefsData.get(key) ?? null
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      prefsData.set(key, value)
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      prefsData.delete(key)
    })
  }
}))

const BASE = 'https://ask.test.invalid'
const NOW = new Date(2026, 9, 21, 15, 30)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

const row = (n: number, daysAgo: number): ChatRow => ({
  id: `c${n}`,
  title: `Chat ${n}`,
  createdAt: new Date(2026, 9, 21 - daysAgo, 12).toISOString(),
  lastViewedAt: null,
  fileCount: 0
})

/** A fake Ask server: the chat list, delete and search. */
function fakeServer(chats: ChatRow[]) {
  let offline = false
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (offline) throw new TypeError('Load failed')
      const url = new URL(String(input))
      const method = init.method ?? 'GET'
      if (method === 'GET' && url.pathname === '/api/chats') {
        return json({
          chats: chats.map(({ id, title, createdAt, lastViewedAt }) => ({
            id,
            title,
            createdAt,
            lastViewedAt,
            userId: 'user-1',
            visibility: 'private'
          })),
          nextOffset: null,
          badges: { c0: { searchMode: 'quality', fileCount: 2 } },
          total: chats.length
        })
      }
      const one = url.pathname.match(/^\/api\/chats\/([^/]+)$/)
      if (method === 'DELETE' && one) {
        chats.splice(
          chats.findIndex(c => c.id === one[1]),
          1
        )
        return json({ ok: true })
      }
      if (method === 'GET' && url.pathname === '/api/chats/search') {
        const q = url.searchParams.get('q')!
        return json({
          results: chats
            .filter(c => c.title.includes(q))
            .map(c => ({
              chatId: c.id,
              chatTitle: c.title,
              snippet: `…${q}…`,
              role: 'user',
              lastViewedAt: null
            }))
        })
      }
      return json({ error: 'unexpected' }, 418)
    }
  )
  vi.mocked(useApi).mockReturnValue({
    client: createApiClient({
      baseUrl: BASE,
      getToken: async () => 'token',
      fetchImpl
    }),
    baseUrl: BASE,
    getToken: async () => 'token'
  } as Api)
  return {
    fetchImpl,
    goOffline(value: boolean) {
      offline = value
    },
    requests(method: string, path: string) {
      return fetchImpl.mock.calls
        .filter(
          ([input, init]) =>
            (init?.method ?? 'GET') === method &&
            new URL(String(input)).pathname === path
        )
        .map(([input]) => new URL(String(input)).searchParams)
    }
  }
}

function renderScreen() {
  const home = { key: 'tabs', render: () => <LibraryScreen /> }
  return render(
    <StackProvider root={home}>
      <LibraryScreen />
    </StackProvider>
  )
}

beforeEach(() => {
  prefsData.clear()
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(useAuth).mockReturnValue({
    session: { user: { id: 'user-1' } }
  } as unknown as Auth)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(375)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('LibraryScreen with the real library hooks', () => {
  it('lists the chats with their badges and count, and deletes one on the server', async () => {
    const server = fakeServer([row(0, 0), row(1, 0), row(2, 3)])
    renderScreen()

    const first = await screen.findByRole('button', { name: /^Chat 0/ })
    expect(screen.getByText('3 chats')).toBeInTheDocument()
    expect(first).toHaveTextContent('Quality')
    expect(first).toHaveTextContent('2 files')
    expect(
      screen.getByRole('region', { name: 'Previous 7 days' })
    ).toHaveTextContent('Chat 2')

    const target = screen.getByRole('button', { name: /^Chat 1/ })
    const at = (x: number) => ({
      clientX: x,
      clientY: 100,
      pointerId: 1,
      isPrimary: true
    })
    fireEvent.pointerDown(target, at(300))
    fireEvent.pointerMove(target, at(250))
    fireEvent.pointerMove(target, at(180))
    fireEvent.pointerUp(target, at(180))
    fireEvent.click(
      within(target.closest('li')!).getByRole('button', { name: 'Delete' })
    )
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: 'Delete this chat?' })
      ).getByRole('button', { name: 'Delete' })
    )

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Chat 1/ })).toBeNull()
    )
    expect(screen.getByText('2 chats')).toBeInTheDocument()
    expect(server.requests('DELETE', '/api/chats/c1')).toHaveLength(1)
  })

  it('shows the cached list offline with an error, and Retry reloads it', async () => {
    const server = fakeServer([row(0, 0), row(5, 1)])
    server.goOffline(true)
    await saveLibraryCache('user-1', {
      sort: 'recent',
      chats: [{ ...row(9, 2), title: 'Cached chat' }],
      total: 1
    })
    renderScreen()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Network error')
    expect(
      screen.getByRole('button', { name: /^Cached chat/ })
    ).toBeInTheDocument()

    server.goOffline(false)
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByRole('button', { name: /^Chat 5/ })
    ).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('Cached chat')).toBeNull()
  })

  it('shows an error with Retry offline with no cache', async () => {
    const server = fakeServer([row(0, 0)])
    server.goOffline(true)
    renderScreen()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t load your chats')
    server.goOffline(false)
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByRole('button', { name: /^Chat 0/ })
    ).toBeInTheDocument()
  })

  it('refetches in the new order on a sort change and remembers it', async () => {
    const user = userEvent.setup()
    const server = fakeServer([row(0, 0)])
    renderScreen()
    await screen.findByRole('button', { name: /^Chat 0/ })

    await user.click(screen.getByRole('button', { name: 'Sort: Recent' }))
    await user.click(screen.getByRole('radio', { name: 'Title' }))

    await waitFor(() =>
      expect(
        server.requests('GET', '/api/chats').map(p => p.get('sort'))
      ).toEqual(['recent', 'title'])
    )
    expect(prefsData.get(LIBRARY_SORT_KEY)).toBe('title')
    expect(
      await screen.findByRole('button', { name: /^Chat 0/ })
    ).toBeInTheDocument()
  })

  it('searches as the user types and goes back to the list on clear', async () => {
    const user = userEvent.setup()
    fakeServer([row(0, 0), row(1, 0)])
    renderScreen()
    await screen.findByRole('button', { name: /^Chat 0/ })

    await user.type(
      screen.getByRole('searchbox', { name: 'Search chats' }),
      'Chat 1'
    )
    const results = await screen.findByRole('list', {
      name: 'Search results'
    })
    await waitFor(() =>
      expect(within(results).getAllByRole('button')).toHaveLength(1)
    )
    expect(within(results).getByRole('button')).toHaveTextContent('…Chat 1…')

    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.queryByRole('list', { name: 'Search results' })).toBeNull()
    expect(screen.getByRole('button', { name: /^Chat 0/ })).toBeInTheDocument()
  })
})
