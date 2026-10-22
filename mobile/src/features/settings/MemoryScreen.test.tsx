import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { createApiClient } from '@/core/api/client'
import { haptic } from '@/core/haptics'
import {
  useScreenActive,
  useStack,
  type ScreenEntry,
  type Stack
} from '@/core/nav/stack'
import {
  MEMORY_UNAVAILABLE,
  RECALL_REFRESH_TIMEOUT_MS,
  REBUILD_FAILED,
  type Memory,
  type MemoryOverview
} from '@/features/settings/memory-api'
import {
  CLEAR_INDEX_ERROR,
  CLEAR_MEMORIES_ERROR,
  DELETE_MEMORY_ERROR,
  MemoryScreen,
  openMemory,
  REBUILD_ERROR,
  REBUILD_STALLED,
  REBUILD_STOPPED,
  SAVE_SETTING_ERROR
} from '@/features/settings/MemoryScreen'

vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))

type AppListener = () => void
const app = vi.hoisted(() => ({
  listeners: new Map<string, Set<() => void>>(),
  remove: vi.fn()
}))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (event: string, listener: AppListener) => {
      const set = app.listeners.get(event) ?? new Set<AppListener>()
      set.add(listener)
      app.listeners.set(event, set)
      return {
        remove: async () => {
          set.delete(listener)
          app.remove()
        }
      }
    })
  }
}))

/** The app goes to the background (Capacitor's 'pause'). */
const appPause = () =>
  act(() => {
    for (const listener of app.listeners.get('pause') ?? []) listener()
  })
vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))
vi.mock('@/core/nav/stack', async importOriginal => ({
  ...(await importOriginal<typeof import('@/core/nav/stack')>()),
  useStack: vi.fn(),
  useScreenActive: vi.fn(() => true)
}))

const BASE = 'https://ask.test.invalid'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

function memory(n: number, overrides: Partial<Memory> = {}): Memory {
  return {
    id: `m${n}`,
    content: `Memory ${n}`,
    category: 'fact',
    status: 'confirmed',
    updatedAt: '2026-10-21T08:00:00.000Z',
    lastUsedAt: null,
    ...overrides
  }
}

const MEMORIES = [
  memory(0, { content: 'Prefers metric units', category: 'preference' }),
  memory(1, { content: 'Lives in Hanoi', category: 'fact' }),
  memory(2, {
    content: 'Into astronomy',
    category: 'interest',
    status: 'candidate'
  })
]

function overview(overrides: Partial<MemoryOverview> = {}): MemoryOverview {
  return {
    enabled: true,
    recallEnabled: true,
    recall: { chunks: 30, chats: 3 },
    memories: MEMORIES,
    ...overrides
  }
}

type Route = (init: RequestInit) => Response | Promise<Response>

let routes: Record<string, Route>
const fetchImpl = vi.fn(
  async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${new URL(String(input)).pathname}`
    const route = routes[key]
    if (!route) throw new Error(`unexpected request ${key}`)
    return route(init)
  }
)
const pop = vi.fn()

/** The requests sent as "METHOD /path". */
const sent = () =>
  fetchImpl.mock.calls.map(
    ([input, init]) =>
      `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`
  )

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

/** A response that only settles when the request aborts. */
const hang: Route = ({ signal }) =>
  new Promise((_resolve, reject) => {
    if (signal!.aborted) reject(signal!.reason)
    signal!.addEventListener('abort', () => reject(signal!.reason))
  })

/** Answers each request with the next response in `list` (the last repeats). */
function sequence(...list: Array<() => Response | Promise<Response>>): Route {
  let i = 0
  return () => list[Math.min(i++, list.length - 1)]()
}

function serve(state: MemoryOverview = overview()) {
  routes = {
    'GET /api/memory': () => json(state),
    'PUT /api/settings/memory': init => {
      const body = JSON.parse(String(init.body)) as {
        memoryEnabled?: boolean
        recallEnabled?: boolean
      }
      return json({
        ok: true,
        enabled: body.memoryEnabled ?? state.enabled,
        recallEnabled: body.recallEnabled ?? state.recallEnabled
      })
    },
    'DELETE /api/memory': () => json({ ok: true }),
    'DELETE /api/memory/recall': () => json({ ok: true }),
    'POST /api/memory/recall': () =>
      json({ messages: 0, chunks: 0, done: true })
  }
  for (const m of state.memories) {
    routes[`DELETE /api/memory/${m.id}`] = () => json({ ok: true })
  }
}

async function renderScreen() {
  const view = render(<MemoryScreen />)
  await screen.findByRole('switch', { name: 'Remember things about me' })
  return view
}

const memorySwitch = () =>
  screen.getByRole('switch', { name: 'Remember things about me' })
const recallSwitch = () =>
  screen.getByRole('switch', { name: 'Use past chats' })
const rebuildButton = () =>
  screen.getByRole('button', { name: /^(Rebuild index|Indexing…)$/ })
const clearIndexButton = () =>
  screen.getByRole('button', { name: 'Clear index' })
const rowButton = (content: string) =>
  screen.getByRole('button', { name: new RegExp(`^${content}`) })

function swipeOpen(content: HTMLElement) {
  const at = (x: number) => ({
    clientX: x,
    clientY: 100,
    pointerId: 1,
    isPrimary: true
  })
  fireEvent.pointerDown(content, at(300))
  fireEvent.pointerMove(content, at(250))
  fireEvent.pointerMove(content, at(180))
  fireEvent.pointerUp(content, at(180))
}

function swipeDelete(content: string) {
  swipeOpen(rowButton(content))
  fireEvent.click(
    within(rowButton(content).closest('li')!).getByRole('button', {
      name: 'Delete'
    })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  app.listeners.clear()
  serve()
  const client = createApiClient({
    baseUrl: BASE,
    getToken: async () => 'token',
    fetchImpl
  })
  vi.mocked(useApi).mockReturnValue({
    client,
    baseUrl: BASE,
    getToken: async () => 'token'
  } satisfies Api)
  vi.mocked(useStack).mockReturnValue({ pop } as unknown as Stack)
  vi.mocked(useScreenActive).mockReturnValue(true)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(375)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// --- Opening and loading ------------------------------------------------------

describe('openMemory', () => {
  it('pushes the Memory screen', async () => {
    const push = vi.fn()
    openMemory(push)
    const entry = push.mock.calls[0][0] as ScreenEntry
    expect(entry.key).toBe('settings:memory')
    render(<>{entry.render()}</>)
    const heading = await screen.findByRole('heading', {
      level: 1,
      name: 'Memory'
    })
    // The side columns hold a 44px button: px, not rem, so a larger iOS
    // text size leaves the title its room.
    expect(heading.closest('header')).toHaveClass(
      'grid-cols-[48px_minmax(0,1fr)_48px]'
    )
  })
})

describe('MemoryScreen: loading', () => {
  it('shows a loading state, then the switches as stored', async () => {
    const reply = deferred<Response>()
    routes['GET /api/memory'] = () => reply.promise
    render(<MemoryScreen />)
    expect(
      screen.getByRole('status', { name: 'Loading memory' })
    ).toBeInTheDocument()

    reply.resolve(json(overview({ enabled: true, recallEnabled: false })))
    expect(
      await screen.findByRole('switch', { name: 'Remember things about me' })
    ).toHaveAttribute('aria-checked', 'true')
    expect(recallSwitch()).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByRole('status', { name: 'Loading memory' })).toBeNull()
  })

  it('scrolls to the top on a status-bar tap and clears the home indicator', async () => {
    await renderScreen()
    const scroller = recallSwitch().closest('[data-scroll-root]')
    expect(scroller).not.toBeNull()
    // The screen covers the tab bar, so its content clears the indicator.
    const content = recallSwitch().closest('.safe-bottom')
    expect(content).not.toBeNull()
    expect(scroller).toContainElement(content as HTMLElement)
  })

  it('says turning memory off keeps what it remembers', async () => {
    await renderScreen()
    expect(
      screen.getByText(/what it already remembers stays/i)
    ).toBeInTheDocument()
  })

  it('goes back', async () => {
    await renderScreen()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(pop).toHaveBeenCalledOnce()
  })

  it('shows a failure with Retry, which loads again', async () => {
    routes['GET /api/memory'] = sequence(
      () => json({ error: 'Failed to load memory', retryable: true }, 500),
      () => json(overview())
    )
    render(<MemoryScreen />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t load your memory')
    expect(alert).toHaveTextContent('Failed to load memory')

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(
      screen.getByRole('status', { name: 'Loading memory' })
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('switch', { name: 'Remember things about me' })
    ).toBeInTheDocument()
  })

  it.each([401, 403])('says memory is unavailable on a %i', async status => {
    routes['GET /api/memory'] = () => json({ error: 'Unauthorized' }, status)
    render(<MemoryScreen />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      MEMORY_UNAVAILABLE
    )
  })

  it('ignores a load that finishes after the screen went away', async () => {
    const reply = deferred<Response>()
    routes['GET /api/memory'] = () => reply.promise
    const error = vi.spyOn(console, 'error')
    const { unmount } = render(<MemoryScreen />)
    unmount()
    reply.resolve(json(overview()))
    await act(async () => {})
    expect(error).not.toHaveBeenCalled()
  })
})

// --- The switches ---------------------------------------------------------------

describe('MemoryScreen: switches', () => {
  it.each([
    ['Remember things about me', 'memoryEnabled'],
    ['Use past chats', 'recallEnabled']
  ])('%s flips at once, then saves %s', async (name, key) => {
    const reply = deferred<Response>()
    routes['PUT /api/settings/memory'] = () => reply.promise
    await renderScreen()
    const toggle = screen.getByRole('switch', { name })
    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(toggle).toBeDisabled()
    expect(haptic).toHaveBeenCalledWith('selection')
    await waitFor(() => expect(sent()).toContain('PUT /api/settings/memory'))
    const [, init] = fetchImpl.mock.calls.at(-1)!
    expect(JSON.parse(String(init!.body))).toEqual({ [key]: false })

    reply.resolve(
      json({
        ok: true,
        enabled: key === 'memoryEnabled' ? false : true,
        recallEnabled: key === 'recallEnabled' ? false : true
      })
    )
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('shows what the server stored', async () => {
    // A server-wide kill switch keeps memory off.
    serve(overview({ enabled: false }))
    routes['PUT /api/settings/memory'] = () =>
      json({ ok: true, enabled: false, recallEnabled: true })
    await renderScreen()
    fireEvent.click(memorySwitch())
    expect(memorySwitch()).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(memorySwitch()).toBeEnabled())
    expect(memorySwitch()).toHaveAttribute('aria-checked', 'false')
  })

  it('leaves the other switch as it is', async () => {
    const reply = deferred<Response>()
    routes['PUT /api/settings/memory'] = sequence(
      () => reply.promise,
      () => json({ ok: true, enabled: true, recallEnabled: false })
    )
    await renderScreen()
    fireEvent.click(memorySwitch())
    fireEvent.click(recallSwitch())
    await waitFor(() => expect(recallSwitch()).toBeEnabled())
    // The first reply still has recall on: it must not undo the second.
    reply.resolve(json({ ok: true, enabled: false, recallEnabled: true }))
    await waitFor(() => expect(memorySwitch()).toBeEnabled())
    expect(memorySwitch()).toHaveAttribute('aria-checked', 'false')
    expect(recallSwitch()).toHaveAttribute('aria-checked', 'false')
  })

  it('reverts and says why when the save fails', async () => {
    routes['PUT /api/settings/memory'] = () =>
      json({ error: 'Failed to update memory settings' }, 500)
    await renderScreen()
    fireEvent.click(recallSwitch())
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(SAVE_SETTING_ERROR)
    expect(alert).toHaveTextContent('Failed to update memory settings')
    expect(recallSwitch()).toHaveAttribute('aria-checked', 'true')
    expect(recallSwitch()).toBeEnabled()
  })

  it('clears the error on the next change', async () => {
    routes['PUT /api/settings/memory'] = sequence(
      () => json({ error: 'Nope' }, 500),
      () => json({ ok: true, enabled: false, recallEnabled: true })
    )
    await renderScreen()
    fireEvent.click(memorySwitch())
    await screen.findByRole('alert')
    fireEvent.click(memorySwitch())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// --- The recall index -----------------------------------------------------------

describe('MemoryScreen: recall index', () => {
  it('says how many chats are indexed', async () => {
    await renderScreen()
    expect(screen.getByText('3 chats indexed')).toBeInTheDocument()
  })

  it('says one chat', async () => {
    serve(overview({ recall: { chunks: 4, chats: 1 } }))
    await renderScreen()
    expect(screen.getByText('1 chat indexed')).toBeInTheDocument()
  })

  it('says when nothing is indexed, and offers no Clear', async () => {
    serve(overview({ recall: { chunks: 0, chats: 0 } }))
    await renderScreen()
    expect(screen.getByText('No chats indexed yet')).toBeInTheDocument()
    expect(clearIndexButton()).toBeDisabled()
  })

  it('cannot rebuild while recall is off', async () => {
    serve(overview({ recallEnabled: false }))
    await renderScreen()
    expect(rebuildButton()).toBeDisabled()
  })

  it('rebuilds batch after batch, with progress, until done', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    routes['POST /api/memory/recall'] = sequence(
      () => first.promise,
      () => second.promise
    )
    routes['GET /api/memory'] = sequence(
      () => json(overview()),
      () => json(overview({ recall: { chunks: 300, chats: 7 } })),
      () => json(overview({ recall: { chunks: 400, chats: 9 } }))
    )
    await renderScreen()
    fireEvent.click(rebuildButton())

    expect(rebuildButton()).toHaveTextContent('Indexing…')
    expect(rebuildButton()).toBeDisabled()
    expect(rebuildButton()).toHaveAttribute('aria-busy', 'true')
    expect(clearIndexButton()).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Indexing your chats…')
    // The rest of the screen stays usable.
    expect(memorySwitch()).toBeEnabled()

    first.resolve(json({ messages: 100, chunks: 270, done: false }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Indexed 7 chats…')
    )
    expect(screen.getByText('7 chats indexed')).toBeInTheDocument()

    second.resolve(json({ messages: 40, chunks: 130, done: true }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Indexed 140 messages.'
      )
    )
    expect(screen.getByText('9 chats indexed')).toBeInTheDocument()
    expect(rebuildButton()).toHaveTextContent('Rebuild index')
    expect(rebuildButton()).toBeEnabled()
    expect(haptic).toHaveBeenCalledWith('success')
    expect(sent().filter(r => r === 'POST /api/memory/recall')).toHaveLength(2)
  })

  it('says when the index was already up to date', async () => {
    await renderScreen()
    fireEvent.click(rebuildButton())
    expect(
      await screen.findByText('The index is already up to date.')
    ).toBeInTheDocument()
  })

  it('keeps going when a progress refresh fails', async () => {
    routes['POST /api/memory/recall'] = sequence(
      () => json({ messages: 10, chunks: 20, done: false }),
      () => json({ messages: 0, chunks: 0, done: true })
    )
    routes['GET /api/memory'] = sequence(
      () => json(overview()),
      () => json({ error: 'Boom' }, 500)
    )
    await renderScreen()
    fireEvent.click(rebuildButton())
    expect(await screen.findByText('Indexed 10 messages.')).toBeInTheDocument()
    expect(screen.getByText('3 chats indexed')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('stops on a batch that made no progress', async () => {
    routes['POST /api/memory/recall'] = sequence(
      () => json({ messages: 25, chunks: 60, done: false }),
      () => json({ messages: 25, chunks: 0, done: false }),
      () => json({ messages: 0, chunks: 0, done: true })
    )
    await renderScreen()
    fireEvent.click(rebuildButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(REBUILD_STALLED)
    expect(sent().filter(r => r === 'POST /api/memory/recall')).toHaveLength(2)
    expect(rebuildButton()).toBeEnabled()
  })

  it('stops after too many rounds', async () => {
    routes['POST /api/memory/recall'] = () =>
      json({ messages: 1, chunks: 1, done: false })
    await renderScreen()
    fireEvent.click(rebuildButton())
    expect(
      await screen.findByRole('alert', {}, { timeout: 5000 })
    ).toHaveTextContent(REBUILD_STOPPED)
  })

  it('says a rebuild failed in the app’s words, never the server’s', async () => {
    routes['POST /api/memory/recall'] = () =>
      json({ error: 'Rebuild failed — see server logs', retryable: true }, 500)
    await renderScreen()
    fireEvent.click(rebuildButton())
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(`${REBUILD_ERROR} ${REBUILD_FAILED}`)
    expect(alert).not.toHaveTextContent(/server logs/)
    expect(rebuildButton()).toBeEnabled()
  })

  it('a double tap on Rebuild starts one rebuild', async () => {
    routes['POST /api/memory/recall'] = hang
    await renderScreen()
    const button = rebuildButton()
    // Both taps land before React re-renders the button as busy.
    act(() => {
      button.click()
      button.click()
    })
    await waitFor(() => expect(sent()).toContain('POST /api/memory/recall'))
    await act(async () => {})
    expect(sent().filter(r => r === 'POST /api/memory/recall')).toHaveLength(1)
  })

  it('a progress refresh that hangs gives up and the rebuild goes on', async () => {
    // The clock still runs (Testing Library waits on it), and can jump.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
      shouldAdvanceTime: true
    })
    routes['POST /api/memory/recall'] = sequence(
      () => json({ messages: 10, chunks: 20, done: false }),
      () => json({ messages: 5, chunks: 9, done: true })
    )
    let gets = 0
    // The refresh after the first batch hangs; the others answer.
    routes['GET /api/memory'] = init =>
      ++gets === 2
        ? hang(init)
        : json(overview({ recall: { chunks: 40, chats: 4 } }))
    await renderScreen()
    fireEvent.click(rebuildButton())
    await waitFor(() => expect(gets).toBe(2))
    expect(screen.queryByText('Indexed 15 messages.')).toBeNull()

    await act(() => vi.advanceTimersByTimeAsync(RECALL_REFRESH_TIMEOUT_MS))

    await waitFor(() =>
      expect(screen.getByText('Indexed 15 messages.')).toBeInTheDocument()
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(sent().filter(r => r === 'POST /api/memory/recall')).toHaveLength(2)
  })

  it('stops indexing when the screen goes away', async () => {
    routes['POST /api/memory/recall'] = hang
    const { unmount } = await renderScreen()
    fireEvent.click(rebuildButton())
    await waitFor(() => expect(sent()).toContain('POST /api/memory/recall'))
    const [, init] = fetchImpl.mock.calls.at(-1)!
    expect(init!.signal!.aborted).toBe(false)
    unmount()
    expect(init!.signal!.aborted).toBe(true)
  })

  it('pauses when the screen is covered, and continues on request', async () => {
    let posts = 0
    routes['POST /api/memory/recall'] = init => {
      posts++
      if (posts === 1) return json({ messages: 50, chunks: 120, done: false })
      if (posts === 2) return hang(init)
      return json({ messages: 30, chunks: 70, done: true })
    }
    routes['GET /api/memory'] = sequence(
      () => json(overview()),
      () => json(overview({ recall: { chunks: 150, chats: 5 } })),
      () => json(overview({ recall: { chunks: 220, chats: 8 } }))
    )
    const { rerender } = await renderScreen()
    fireEvent.click(rebuildButton())
    await waitFor(() => expect(posts).toBe(2))
    const [, init] = fetchImpl.mock.calls.at(-1)!

    vi.mocked(useScreenActive).mockReturnValue(false)
    rerender(<MemoryScreen />)
    expect(init!.signal!.aborted).toBe(true)
    // Uncovered again: the progress so far, and a way to go on.
    vi.mocked(useScreenActive).mockReturnValue(true)
    rerender(<MemoryScreen />)
    expect(
      await screen.findByText('Rebuild paused — 5 chats indexed')
    ).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(rebuildButton()).toHaveTextContent('Rebuild index')
    await act(async () => {})
    expect(posts).toBe(2)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Indexed 30 messages.')).toBeInTheDocument()
    expect(posts).toBe(3)
  })

  it('pauses when the app goes to the background, and continues on request', async () => {
    let posts = 0
    routes['POST /api/memory/recall'] = init => {
      posts++
      if (posts === 1) return json({ messages: 50, chunks: 120, done: false })
      if (posts === 2) return hang(init)
      return json({ messages: 30, chunks: 70, done: true })
    }
    routes['GET /api/memory'] = sequence(
      () => json(overview()),
      () => json(overview({ recall: { chunks: 150, chats: 5 } })),
      () => json(overview({ recall: { chunks: 220, chats: 8 } }))
    )
    await renderScreen()
    fireEvent.click(rebuildButton())
    await waitFor(() => expect(posts).toBe(2))
    const [, init] = fetchImpl.mock.calls.at(-1)!
    expect(init!.signal!.aborted).toBe(false)

    await appPause()
    expect(init!.signal!.aborted).toBe(true)
    expect(
      await screen.findByText('Rebuild paused — 5 chats indexed')
    ).toBeInTheDocument()
    // An aborted batch is not a failure, and nothing resumes by itself.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(rebuildButton()).toHaveTextContent('Rebuild index')
    await act(async () => {})
    expect(posts).toBe(2)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.queryByText(/Rebuild paused/)).toBeNull()
    expect(await screen.findByText('Indexed 30 messages.')).toBeInTheDocument()
    expect(posts).toBe(3)
    expect(screen.getByText('8 chats indexed')).toBeInTheDocument()
  })

  it('pausing with no rebuild running does nothing', async () => {
    await renderScreen()
    await appPause()
    expect(screen.queryByText(/Rebuild paused/)).toBeNull()
    expect(sent()).not.toContain('POST /api/memory/recall')
  })

  it('stops listening for the background once gone', async () => {
    const { unmount } = await renderScreen()
    await waitFor(() => expect(app.listeners.get('pause')?.size).toBe(1))
    unmount()
    await waitFor(() => expect(app.remove).toHaveBeenCalledOnce())
    expect(app.listeners.get('pause')?.size).toBe(0)
  })

  it('leaving a paused rebuild still stops it', async () => {
    routes['POST /api/memory/recall'] = hang
    const { unmount } = await renderScreen()
    fireEvent.click(rebuildButton())
    await waitFor(() => expect(sent()).toContain('POST /api/memory/recall'))
    await appPause()
    await screen.findByText(/Rebuild paused/)
    unmount()
    await act(async () => {})
    expect(sent().filter(r => r === 'POST /api/memory/recall')).toHaveLength(1)
  })

  it('clears the index after a confirmation', async () => {
    await renderScreen()
    fireEvent.click(clearIndexButton())
    const sheet = screen.getByRole('dialog', {
      name: 'Clear the recall index?'
    })
    expect(sent()).not.toContain('DELETE /api/memory/recall')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Clear index' }))

    expect(await screen.findByText('No chats indexed yet')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Index cleared.')
    expect(sent()).toContain('DELETE /api/memory/recall')
  })

  it('shows Clear index as busy while it runs', async () => {
    const reply = deferred<Response>()
    routes['DELETE /api/memory/recall'] = () => reply.promise
    await renderScreen()
    fireEvent.click(clearIndexButton())
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Clear index'
      })
    )
    expect(screen.getByRole('button', { name: 'Clearing…' })).toBeDisabled()
    expect(rebuildButton()).toBeDisabled()
    reply.resolve(json({ ok: true }))
    expect(await screen.findByText('No chats indexed yet')).toBeInTheDocument()
    expect(rebuildButton()).toBeEnabled()
  })

  it('cancelling clears nothing', async () => {
    await renderScreen()
    fireEvent.click(clearIndexButton())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(sent()).not.toContain('DELETE /api/memory/recall')
    expect(screen.getByText('3 chats indexed')).toBeInTheDocument()
  })

  it('says why clearing the index failed', async () => {
    routes['DELETE /api/memory/recall'] = () => json({ error: 'Nope' }, 500)
    await renderScreen()
    fireEvent.click(clearIndexButton())
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Clear index'
      })
    )
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(CLEAR_INDEX_ERROR)
    expect(screen.getByText('3 chats indexed')).toBeInTheDocument()
  })
})

// --- The memories ---------------------------------------------------------------

describe('MemoryScreen: memories', () => {
  it('lists each memory with its category, and Learning for a candidate', async () => {
    await renderScreen()
    const list = screen.getByRole('list', { name: 'What Ask remembers' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Prefers metric units')
    expect(items[0]).toHaveTextContent('Preference')
    expect(items[0]).not.toHaveTextContent('Learning')
    expect(items[1]).toHaveTextContent('Fact')
    expect(items[2]).toHaveTextContent('Interest')
    expect(items[2]).toHaveTextContent('Learning')
    // 11px at the default 16px root, and it follows the text size.
    expect(within(items[2]).getByText('Learning')).toHaveClass(
      'text-[0.6875rem]'
    )
  })

  it('the rows sit on the list’s card tint, with no action colour at rest', async () => {
    await renderScreen()
    const list = screen.getByRole('list', { name: 'What Ask remembers' })
    expect(list).toHaveClass('bg-card')
    const row = rowButton('Prefers metric units')
    expect(row).toHaveClass('bg-card')
    // Nothing red behind the content: no red at the rounded corners.
    expect(row.parentElement!.className).not.toContain('bg-red-600')
  })

  it('the Learning badge is white on the accent fill (4.94:1 in both themes)', async () => {
    await renderScreen()
    const list = screen.getByRole('list', { name: 'What Ask remembers' })
    expect(within(list).getAllByText('Learning')[0]).toHaveClass(
      'bg-accent-fill',
      'text-white'
    )
  })

  it('separates every memory but the last with an inset hairline', async () => {
    await renderScreen()
    const list = screen.getByRole('list', { name: 'What Ask remembers' })
    expect(list.className).not.toContain('divide-y')
    const separated = within(list)
      .getAllByRole('listitem')
      .map(item =>
        within(item)
          .getAllByRole('button')
          .at(-1)!
          .firstElementChild!.className.includes('after:h-px')
      )
    expect(separated).toEqual([true, true, false])
  })

  it('its destructive actions read as destructive', async () => {
    await renderScreen()
    expect(clearIndexButton()).toHaveClass('text-destructive')
    expect(
      screen.getByRole('button', { name: 'Clear all memories' })
    ).toHaveClass('text-destructive')
  })

  it('says when there are none, and offers no Clear all', async () => {
    serve(overview({ memories: [] }))
    await renderScreen()
    expect(screen.getByText('No memories yet')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Clear all memories' })
    ).toBeNull()
  })

  it('says memory is off when there are none and it is off', async () => {
    serve(overview({ memories: [], enabled: false }))
    await renderScreen()
    expect(
      screen.getByText(/Memory is off, so Ask isn’t learning/)
    ).toBeInTheDocument()
  })

  it('deletes one after a confirmation from the swipe', async () => {
    await renderScreen()
    swipeDelete('Lives in Hanoi')
    const sheet = screen.getByRole('dialog', { name: 'Delete this memory?' })
    expect(sheet).toHaveTextContent('Lives in Hanoi')
    expect(sent()).not.toContain('DELETE /api/memory/m1')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }))

    // Out of the list at once.
    expect(screen.queryByText('Lives in Hanoi')).toBeNull()
    await waitFor(() => expect(sent()).toContain('DELETE /api/memory/m1'))
  })

  it('deletes one after a confirmation from a long press', async () => {
    await renderScreen()
    const row = rowButton('Lives in Hanoi')
    expect(row).toHaveAccessibleDescription('Touch and hold for Delete.')
    expect(row.querySelector('.selectable')).toBeNull()
    fireEvent.contextMenu(row)
    const actions = screen.getByRole('dialog', { name: 'Memory' })
    fireEvent.click(within(actions).getByRole('button', { name: 'Delete' }))
    const sheet = screen.getByRole('dialog', { name: 'Delete this memory?' })
    expect(sheet).toHaveTextContent('Lives in Hanoi')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(sent()).toContain('DELETE /api/memory/m1'))
  })

  it('cancelling the confirmation deletes nothing', async () => {
    await renderScreen()
    swipeDelete('Lives in Hanoi')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(rowButton('Lives in Hanoi')).toBeInTheDocument()
    expect(sent()).not.toContain('DELETE /api/memory/m1')
  })

  it('puts a memory back, in its place, when the delete fails', async () => {
    routes['DELETE /api/memory/m1'] = () => json({ error: 'Nope' }, 500)
    await renderScreen()
    swipeDelete('Lives in Hanoi')
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Delete'
      })
    )
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(DELETE_MEMORY_ERROR)
    const items = within(
      screen.getByRole('list', { name: 'What Ask remembers' })
    ).getAllByRole('listitem')
    expect(items[1]).toHaveTextContent('Lives in Hanoi')
  })

  it('treats a memory already gone as deleted', async () => {
    routes['DELETE /api/memory/m1'] = () => json({ error: 'Not found' }, 404)
    await renderScreen()
    swipeDelete('Lives in Hanoi')
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Delete'
      })
    )
    await waitFor(() => expect(sent()).toContain('DELETE /api/memory/m1'))
    await act(async () => {})
    expect(screen.queryByText('Lives in Hanoi')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the whole memory on a tap, and can delete it from there', async () => {
    await renderScreen()
    fireEvent.click(rowButton('Into astronomy'))
    const sheet = screen.getByRole('dialog', { name: 'Interest' })
    expect(sheet).toHaveTextContent('Into astronomy')
    expect(sheet).toHaveTextContent('Learning')
    // White on the AA red fill.
    expect(
      within(sheet).getByRole('button', { name: 'Delete memory' })
    ).toHaveClass('bg-red-600', 'text-white')

    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Delete memory' })
    )
    expect(haptic).toHaveBeenCalledWith('warning')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('Into astronomy')).toBeNull()
    await waitFor(() => expect(sent()).toContain('DELETE /api/memory/m2'))
  })

  it('lets the whole memory be selected and copied', async () => {
    await renderScreen()
    fireEvent.click(rowButton('Into astronomy'))
    const sheet = screen.getByRole('dialog', { name: 'Interest' })
    expect(within(sheet).getByText('Into astronomy')).toHaveClass('selectable')
  })

  it('closes the memory with Done', async () => {
    await renderScreen()
    fireEvent.click(rowButton('Prefers metric units'))
    const sheet = screen.getByRole('dialog', { name: 'Preference' })
    expect(sheet).not.toHaveTextContent('Learning')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(rowButton('Prefers metric units')).toBeInTheDocument()
  })

  it('closes the memory on Escape', async () => {
    await renderScreen()
    fireEvent.click(rowButton('Lives in Hanoi'))
    expect(screen.getByRole('dialog', { name: 'Fact' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(sent()).not.toContain('DELETE /api/memory/m1')
  })

  it('clears all after a confirmation', async () => {
    await renderScreen()
    fireEvent.click(screen.getByRole('button', { name: 'Clear all memories' }))
    const sheet = screen.getByRole('dialog', { name: 'Clear all memories?' })
    expect(sent()).not.toContain('DELETE /api/memory')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Clear all' }))

    expect(await screen.findByText('No memories yet')).toBeInTheDocument()
    expect(
      screen.getByText('All memories cleared.', { selector: '[role=status]' })
    ).toBeInTheDocument()
    expect(sent()).toContain('DELETE /api/memory')
  })

  it('cancelling Clear all clears nothing', async () => {
    await renderScreen()
    fireEvent.click(screen.getByRole('button', { name: 'Clear all memories' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(sent()).not.toContain('DELETE /api/memory')
    expect(rowButton('Lives in Hanoi')).toBeInTheDocument()
  })

  it('shows Clear all as busy while it runs', async () => {
    const reply = deferred<Response>()
    routes['DELETE /api/memory'] = () => reply.promise
    await renderScreen()
    fireEvent.click(screen.getByRole('button', { name: 'Clear all memories' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Clear all'
      })
    )
    const button = screen.getByRole('button', { name: 'Clearing…' })
    expect(button).toBeDisabled()
    reply.resolve(json({ ok: true }))
    expect(await screen.findByText('No memories yet')).toBeInTheDocument()
  })

  it('says why Clear all failed, and keeps the memories', async () => {
    routes['DELETE /api/memory'] = () => json({ error: 'Nope' }, 500)
    await renderScreen()
    fireEvent.click(screen.getByRole('button', { name: 'Clear all memories' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Clear all'
      })
    )
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(CLEAR_MEMORIES_ERROR)
    expect(rowButton('Lives in Hanoi')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Clear all memories' })
    ).toBeEnabled()
  })
})
