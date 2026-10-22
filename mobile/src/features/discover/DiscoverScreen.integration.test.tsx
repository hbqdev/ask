// The Discover screen over the real useDiscover, with a fake Ask server
// behind the real API client: what Retry asks the server for.

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { createApiClient } from '@/core/api/client'
import { StackProvider } from '@/core/nav/stack'
import { DiscoverScreen } from '@/features/discover/DiscoverScreen'
import { resetDiscoverCache } from '@/features/discover/useDiscover'
import { intersect, isObserved } from '@/test/intersection-observer'

vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async () => ({ value: null })),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {})
  }
}))

const BASE = 'https://ask.test.invalid'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

/** Two stories per page: "Story <page>.<i>". */
const page = (n: number) =>
  [1, 2].map(i => ({
    title: `Story ${n}.${i}`,
    content: `Summary ${n}.${i}`,
    url: `https://news.example.test/${n}/${i}`,
    thumbnail: `https://img.example.test/${n}/${i}.jpg`
  }))

/** A fake /api/discover whose listed pages fail once each. */
function fakeServer(failOnce: number[]) {
  const failing = new Set(failOnce)
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const n = Number(new URL(String(input)).searchParams.get('page'))
    if (failing.delete(n)) return json({ message: 'boom' }, 500)
    return json({ blogs: page(n) })
  })
  return {
    fetchImpl,
    /** The pages asked for so far, in order. */
    pages: () =>
      fetchImpl.mock.calls.map(([input]) =>
        Number(new URL(String(input)).searchParams.get('page'))
      )
  }
}

function renderScreen(failOnce: number[]) {
  const server = fakeServer(failOnce)
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
  render(
    <StackProvider root={{ key: 'tabs', render: () => <DiscoverScreen /> }}>
      <DiscoverScreen />
    </StackProvider>
  )
  return server
}

beforeEach(() => {
  resetDiscoverCache()
  vi.clearAllMocks()
})

describe('DiscoverScreen Retry', () => {
  it('after a failed next page asks for that page, keeping the stories', async () => {
    const server = renderScreen([2])
    await screen.findByRole('heading', { name: 'Story 1.1' })
    const sentinel = screen.getByTestId('discover-more')
    await waitFor(() => expect(isObserved(sentinel)).toBe(true))
    act(() => intersect(sentinel))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Request failed (500)')
    expect(screen.getByText('Story 1.2')).toBeInTheDocument()

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Story 2.1')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Story 1.1' })).toBeVisible()
    expect(server.pages()).toEqual([1, 2, 2])
  })

  it('after a failed page 1 asks for page 1 again', async () => {
    const server = renderScreen([1])
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t load the news')

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByRole('heading', { name: 'Story 1.1' })
    ).toBeInTheDocument()
    expect(server.pages()).toEqual([1, 1])
  })
})
