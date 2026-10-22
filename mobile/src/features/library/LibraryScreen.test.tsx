import { Preferences } from '@capacitor/preferences'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Tabs, useSelectTab } from '@/app/Tabs'
import { haptic } from '@/core/haptics'
import { StackProvider } from '@/core/nav/stack'
import { groupByDate } from '@/features/library/group-by-date'
import type { ChatRow, SearchHit } from '@/features/library/library-api'
import { LIBRARY_SEGMENT_KEY } from '@/features/library/library-segment'
import { LIBRARY_SORT_KEY } from '@/features/library/library-sort'
import { LibraryScreen } from '@/features/library/LibraryScreen'
import { relativeTime } from '@/features/library/relative-time'
import {
  useChatSearch,
  useLibrary,
  type ChatSearch,
  type Library
} from '@/features/library/useLibrary'
import { useNotes, type Notes } from '@/features/notes/useNotes'
import { openThread } from '@/features/thread/ThreadScreen'
import { intersect, isObserved, observerOf } from '@/test/intersection-observer'

vi.mock('@/features/library/useLibrary', () => ({
  useLibrary: vi.fn(),
  useChatSearch: vi.fn()
}))
vi.mock('@/features/thread/ThreadScreen', () => ({ openThread: vi.fn() }))
vi.mock('@/features/notes/useNotes', () => ({ useNotes: vi.fn() }))
vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))
vi.mock('@/app/Tabs', async importOriginal => ({
  ...(await importOriginal<typeof import('@/app/Tabs')>()),
  useSelectTab: vi.fn()
}))
// Spies over the real functions: each row render calls relativeTime once,
// and each list render (outside the title sort) calls groupByDate once.
vi.mock('@/features/library/relative-time', async importOriginal => {
  const real =
    await importOriginal<typeof import('@/features/library/relative-time')>()
  return { relativeTime: vi.fn(real.relativeTime) }
})
vi.mock('@/features/library/group-by-date', async importOriginal => {
  const real =
    await importOriginal<typeof import('@/features/library/group-by-date')>()
  return { groupByDate: vi.fn(real.groupByDate) }
})

type AppStateListener = (state: { isActive: boolean }) => void
const app = vi.hoisted(() => ({
  listeners: [] as Array<(state: { isActive: boolean }) => void>
}))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (_event: string, listener: AppStateListener) => {
      app.listeners.push(listener)
      return {
        remove: async () => {
          app.listeners.splice(app.listeners.indexOf(listener), 1)
        }
      }
    })
  }
}))

/** The app comes back to the foreground. */
const resumeApp = () =>
  act(() => {
    for (const listener of [...app.listeners]) listener({ isActive: true })
  })

const prefsData = vi.hoisted(() => new Map<string, string>())
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: prefsData.get(key) ?? null
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      prefsData.set(key, value)
    }),
    remove: vi.fn(async () => {})
  }
}))

// --- Fixtures ----------------------------------------------------------------

// Local times, so the date sections are the device's days.
const NOW = new Date(2026, 9, 21, 15, 30)
const daysAgo = (n: number) => new Date(2026, 9, 21 - n, 12).toISOString()

const row = (id: string, over: Partial<ChatRow> = {}): ChatRow => ({
  id,
  title: `Chat ${id}`,
  createdAt: daysAgo(40),
  lastViewedAt: null,
  fileCount: 0,
  ...over
})

const ROWS = [
  row('a', { lastViewedAt: daysAgo(0), createdAt: daysAgo(3) }),
  row('b', { lastViewedAt: daysAgo(1), createdAt: daysAgo(0) }),
  row('c', { lastViewedAt: null, createdAt: daysAgo(3) })
]

function library(over: Partial<Library> = {}): Library {
  return {
    chats: ROWS,
    total: 3,
    status: 'ready',
    error: undefined,
    hasMore: false,
    loadMore: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    remove: vi.fn(async () => true),
    rename: vi.fn(async () => true),
    ...over
  }
}

function chatSearch(over: Partial<ChatSearch> = {}): ChatSearch {
  return {
    query: '',
    setQuery: vi.fn(),
    results: [],
    status: 'idle',
    submit: vi.fn(),
    ...over
  }
}

function notesState(over: Partial<Notes> = {}): Notes {
  return {
    notes: [
      {
        id: 'n1',
        title: 'Note one',
        content: 'Saved answer',
        chatId: null,
        sourceMessageId: null,
        createdAt: daysAgo(0),
        updatedAt: daysAgo(0)
      }
    ],
    status: 'ready',
    error: undefined,
    hasMore: false,
    loadMore: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    remove: vi.fn(async () => true),
    ...over
  }
}

const HOME = { key: 'tabs', render: () => <LibraryScreen /> }

/** The screen as the stack's root, once the stored sort has loaded. */
async function renderScreen(
  lib: Library = library(),
  search: ChatSearch = chatSearch()
) {
  vi.mocked(useLibrary).mockReturnValue(lib)
  vi.mocked(useChatSearch).mockReturnValue(search)
  const utils = render(
    <StackProvider root={HOME}>
      <LibraryScreen />
    </StackProvider>
  )
  await screen.findByRole('heading', { level: 1, name: 'Library' })
  await waitFor(() => expect(useLibrary).toHaveBeenCalled())
  return {
    ...utils,
    update(next: { lib?: Library; search?: ChatSearch }) {
      if (next.lib) vi.mocked(useLibrary).mockReturnValue(next.lib)
      if (next.search) vi.mocked(useChatSearch).mockReturnValue(next.search)
      utils.rerender(
        <StackProvider root={HOME}>
          <LibraryScreen />
        </StackProvider>
      )
    }
  }
}

/** The screen in the tab shell, beside a Settings tab to switch to. */
async function renderInTabs(lib: Library) {
  vi.mocked(useLibrary).mockReturnValue(lib)
  vi.mocked(useChatSearch).mockReturnValue(chatSearch())
  render(
    <StackProvider root={HOME}>
      <Tabs
        tabs={[
          {
            id: 'library',
            label: 'Library',
            icon: null,
            render: () => <LibraryScreen />
          },
          {
            id: 'settings',
            label: 'Settings',
            icon: null,
            render: () => <p>Settings</p>
          }
        ]}
      />
    </StackProvider>
  )
  await screen.findByRole('heading', { level: 1, name: 'Library' })
  const user = userEvent.setup()
  return {
    showTab: (name: string) => user.click(screen.getByRole('tab', { name }))
  }
}

const rowButton = (title: string) =>
  screen.getByRole('button', { name: new RegExp(`^${title}`) })

/** Opens a row's swipe actions with a left drag, as a finger would. */
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

function swipeAction(title: string, action: 'Delete' | 'Rename') {
  const content = rowButton(title)
  swipeOpen(content)
  fireEvent.click(
    within(content.closest('li')!).getByRole('button', { name: action })
  )
}

/** The date sections, by their accessible names (their headings). */
const sectionNames = () =>
  screen
    .getAllByRole('region')
    .map(section =>
      section.getAttribute('aria-labelledby')
        ? document.getElementById(section.getAttribute('aria-labelledby')!)!
            .textContent
        : null
    )

const selectTab = vi.fn()

beforeEach(() => {
  prefsData.clear()
  app.listeners.length = 0
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(useSelectTab).mockReturnValue(selectTab)
  vi.mocked(useNotes).mockReturnValue(notesState())
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(375)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// --- Header -------------------------------------------------------------------

describe('LibraryScreen header', () => {
  it('shows the total count', async () => {
    await renderScreen(library({ total: 42 }))
    expect(screen.getByText('42 chats')).toBeInTheDocument()
  })

  it('says "1 chat" for one', async () => {
    await renderScreen(library({ total: 1, chats: [ROWS[0]] }))
    expect(screen.getByText('1 chat')).toBeInTheDocument()
  })

  it('shows no count until it is known', async () => {
    await renderScreen(library({ total: undefined }))
    expect(screen.queryByText(/\d+ chats?$/)).toBeNull()
  })

  it('waits for the stored sort before loading the list', async () => {
    prefsData.set(LIBRARY_SORT_KEY, 'title')
    await renderScreen()
    expect(useLibrary).toHaveBeenCalledWith({ sort: 'title' })
    expect(useLibrary).not.toHaveBeenCalledWith({ sort: 'recent' })
    expect(screen.getByRole('button', { name: 'Sort: Title' })).toBeVisible()
  })

  it('persists a sort change and loads the list in that order', async () => {
    const user = userEvent.setup()
    await renderScreen()
    expect(useLibrary).toHaveBeenLastCalledWith({ sort: 'recent' })

    await user.click(screen.getByRole('button', { name: 'Sort: Recent' }))
    const menu = screen.getByRole('dialog', { name: 'Sort by' })
    const options = within(menu).getAllByRole('radio')
    expect(options.map(o => o.textContent)).toEqual([
      'Recent',
      'Newest',
      'Oldest',
      'Title'
    ])
    expect(options[0]).toHaveAttribute('aria-checked', 'true')

    await user.click(within(menu).getByRole('radio', { name: 'Oldest' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useLibrary).toHaveBeenLastCalledWith({ sort: 'oldest' })
    expect(Preferences.set).toHaveBeenCalledWith({
      key: LIBRARY_SORT_KEY,
      value: 'oldest'
    })
    expect(screen.getByRole('button', { name: 'Sort: Oldest' })).toBeVisible()
  })

  it('keeps the sort when the menu is dismissed', async () => {
    const user = userEvent.setup()
    await renderScreen()
    await user.click(screen.getByRole('button', { name: 'Sort: Recent' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useLibrary).toHaveBeenLastCalledWith({ sort: 'recent' })
    expect(Preferences.set).not.toHaveBeenCalled()
  })

  it('goes back to the top of the list on a sort change', async () => {
    const user = userEvent.setup()
    await renderScreen()
    const scroller = screen.getByTestId('library-scroll')
    scroller.scrollTop = 500
    await user.click(screen.getByRole('button', { name: 'Sort: Recent' }))
    await user.click(screen.getByRole('radio', { name: 'Title' }))
    expect(scroller.scrollTop).toBe(0)
  })
})

// --- List ---------------------------------------------------------------------

describe('LibraryScreen list', () => {
  it('renders the rows in date sections by last viewed for the recent sort', async () => {
    await renderScreen()
    const sections = screen.getAllByRole('region')
    expect(sectionNames()).toEqual(['Today', 'Yesterday', 'Previous 7 days'])
    expect(within(sections[0]).getByText('Chat a')).toBeInTheDocument()
    expect(within(sections[1]).getByText('Chat b')).toBeInTheDocument()
    // Never viewed: its creation date.
    expect(within(sections[2]).getByText('Chat c')).toBeInTheDocument()
    expect(
      within(sections[0]).getByRole('heading', { level: 2, name: 'Today' })
    ).toBeInTheDocument()
  })

  it('moves the rows to the next day’s sections when the app comes back after midnight', async () => {
    await renderScreen()
    expect(sectionNames()).toEqual(['Today', 'Yesterday', 'Previous 7 days'])

    vi.setSystemTime(new Date(2026, 9, 22, 8, 0))
    // Backgrounding alone changes nothing.
    act(() => {
      for (const listener of [...app.listeners]) listener({ isActive: false })
    })
    expect(sectionNames()).toEqual(['Today', 'Yesterday', 'Previous 7 days'])
    resumeApp()

    expect(sectionNames()).toEqual(['Yesterday', 'Previous 7 days'])
  })

  it('moves the rows to the next day’s sections when the tab is shown after midnight', async () => {
    const { showTab } = await renderInTabs(library())
    await showTab('Settings')
    vi.setSystemTime(new Date(2026, 9, 22, 8, 0))

    await showTab('Library')

    expect(sectionNames()).toEqual(['Yesterday', 'Previous 7 days'])
  })

  it('stops listening for the app coming back once gone', async () => {
    const { unmount } = await renderScreen()
    await waitFor(() => expect(app.listeners).toHaveLength(1))
    unmount()
    await waitFor(() => expect(app.listeners).toHaveLength(0))
  })

  it('sections by creation date for the newest and oldest sorts', async () => {
    prefsData.set(LIBRARY_SORT_KEY, 'newest')
    await renderScreen(library({ chats: [ROWS[1], ROWS[0], ROWS[2]] }))
    const sections = screen.getAllByRole('region')
    expect(sectionNames()).toEqual(['Today', 'Previous 7 days'])
    expect(within(sections[0]).getByText('Chat b')).toBeInTheDocument()
    // Row times follow the same date.
    expect(rowButton('Chat a')).toHaveTextContent('3 days ago')
  })

  it('shows the title sort as one flat list', async () => {
    prefsData.set(LIBRARY_SORT_KEY, 'title')
    await renderScreen()
    expect(screen.queryAllByRole('heading', { level: 2 })).toEqual([])
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('opens a chat on a tap with its id and title', async () => {
    await renderScreen()
    fireEvent.click(rowButton('Chat b'))
    expect(openThread).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      chatId: 'b',
      title: 'Chat b'
    })
  })

  it('loads more when the end of the list comes into view', async () => {
    const lib = library({ hasMore: true })
    await renderScreen(lib)
    const sentinel = screen.getByTestId('library-more')
    act(() => intersect(sentinel, false))
    expect(lib.loadMore).not.toHaveBeenCalled()
    act(() => intersect(sentinel))
    expect(lib.loadMore).toHaveBeenCalledOnce()
  })

  it('watches the end again after a page lands, in case it is still in view', async () => {
    const lib = library({ hasMore: true, chats: ROWS.slice(0, 2) })
    const { update } = await renderScreen(lib)
    const first = screen.getByTestId('library-more')
    update({ lib: { ...lib, chats: ROWS } })
    const after = screen.getByTestId('library-more')
    expect(isObserved(after)).toBe(true)
    act(() => intersect(after))
    expect(lib.loadMore).toHaveBeenCalledOnce()
    expect(first).toBe(after)
  })

  it('watches the end afresh after a page of only rows already shown', async () => {
    const lib = library({ hasMore: true })
    const { update } = await renderScreen(lib)
    const sentinel = screen.getByTestId('library-more')
    const before = observerOf(sentinel)

    // The page's rows were all duplicates: same count, a new list.
    update({ lib: { ...lib, chats: [...ROWS] } })

    expect(screen.getByTestId('library-more')).toBe(sentinel)
    expect(observerOf(sentinel)).toBeDefined()
    expect(observerOf(sentinel)).not.toBe(before)
  })

  it('does not page while the Library tab is hidden, and watches again when shown', async () => {
    const lib = library({ hasMore: true })
    const { showTab } = await renderInTabs(lib)
    const sentinel = await screen.findByTestId('library-more')
    expect(isObserved(sentinel)).toBe(true)

    await showTab('Settings')
    expect(isObserved(sentinel)).toBe(false)
    act(() => intersect(sentinel))
    expect(lib.loadMore).not.toHaveBeenCalled()

    await showTab('Library')
    expect(isObserved(sentinel)).toBe(true)
    act(() => intersect(sentinel))
    expect(lib.loadMore).toHaveBeenCalledOnce()
  })

  it('keeps loading when every loaded row is deleted but more remain', async () => {
    const lib = library({ chats: [], total: 40, hasMore: true })
    await renderScreen(lib)
    expect(screen.queryByText('No chats yet')).toBeNull()
    expect(
      screen.getByRole('status', { name: 'Loading chats' })
    ).toBeInTheDocument()
    act(() => intersect(screen.getByTestId('library-more')))
    expect(lib.loadMore).toHaveBeenCalledOnce()
  })

  it('has no end to watch when there is nothing more', async () => {
    await renderScreen(library({ hasMore: false }))
    expect(screen.queryByTestId('library-more')).toBeNull()
  })

  it('refreshes on a pull down from the top', async () => {
    const lib = library()
    await renderScreen(lib)
    const scroller = screen.getByTestId('library-scroll')
    const touch = (y: number) => ({ identifier: 0, clientX: 100, clientY: y })
    fireEvent.touchStart(scroller, {
      touches: [touch(100)],
      changedTouches: [touch(100)]
    })
    fireEvent.touchMove(scroller, {
      touches: [touch(400)],
      changedTouches: [touch(400)]
    })
    const content = screen.getByTestId('library-content')
    expect(content.style.transform).toMatch(/^translate3d\(0, [\d.]+px, 0\)$/)
    expect(content).not.toHaveClass('pull-settle')
    await act(async () =>
      fireEvent.touchEnd(scroller, {
        touches: [],
        changedTouches: [touch(400)]
      })
    )
    expect(lib.refresh).toHaveBeenCalledOnce()
    expect(content).toHaveClass('pull-settle')
  })
})

// --- Swipe actions --------------------------------------------------------------

describe('LibraryScreen swipe actions', () => {
  it('deletes a chat after confirming', async () => {
    const lib = library()
    await renderScreen(lib)
    swipeAction('Chat b', 'Delete')
    const sheet = screen.getByRole('dialog', { name: 'Delete this chat?' })
    expect(lib.remove).not.toHaveBeenCalled()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }))
    expect(lib.remove).toHaveBeenCalledExactlyOnceWith('b')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the chat when the delete is cancelled', async () => {
    const lib = library()
    await renderScreen(lib)
    swipeAction('Chat b', 'Delete')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(lib.remove).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renames a chat with the trimmed title', async () => {
    const user = userEvent.setup()
    const lib = library()
    await renderScreen(lib)
    swipeAction('Chat a', 'Rename')
    const field = screen.getByRole('textbox', { name: 'Rename chat' })
    expect(field).toHaveValue('Chat a')
    expect(field).toHaveAttribute('maxLength', '255')
    await user.clear(field)
    await user.type(field, '  Sky colours  {Enter}')
    expect(lib.rename).toHaveBeenCalledExactlyOnceWith('a', 'Sky colours')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('blocks an empty rename', async () => {
    const user = userEvent.setup()
    const lib = library()
    await renderScreen(lib)
    swipeAction('Chat a', 'Rename')
    const sheet = screen.getByRole('dialog', { name: 'Rename chat' })
    const field = within(sheet).getByRole('textbox', { name: 'Rename chat' })
    await user.clear(field)
    await user.type(field, '   {Enter}')
    expect(within(sheet).getByRole('button', { name: 'Rename' })).toBeDisabled()
    expect(lib.rename).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Rename chat' })).toBeVisible()
  })
})

// --- Search ---------------------------------------------------------------------

const HITS: SearchHit[] = [
  {
    chatId: 'b',
    title: 'Chat b',
    snippet: '…the sky is blue because…',
    lastViewedAt: null
  },
  { chatId: 'z', title: '', snippet: 'an untitled match', lastViewedAt: null }
]

describe('LibraryScreen search', () => {
  it('passes typing to the search', async () => {
    const search = chatSearch()
    await renderScreen(library(), search)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search chats' }), {
      target: { value: 'sky' }
    })
    expect(search.setQuery).toHaveBeenLastCalledWith('sky')
  })

  it('shows the results (title and snippet) instead of the list', async () => {
    await renderScreen(
      library(),
      chatSearch({ query: 'sky', results: HITS, status: 'ready' })
    )
    const results = screen.getByRole('list', { name: 'Search results' })
    const items = within(results).getAllByRole('button')
    expect(items[0]).toHaveTextContent('Chat b')
    expect(items[0]).toHaveTextContent('…the sky is blue because…')
    expect(items[1]).toHaveTextContent('Untitled')
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryByTestId('library-more')).toBeNull()
  })

  it('opens the chat of a tapped result', async () => {
    await renderScreen(
      library(),
      chatSearch({ query: 'sky', results: HITS, status: 'ready' })
    )
    fireEvent.click(screen.getByRole('button', { name: /^Chat b/ }))
    expect(openThread).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      chatId: 'b',
      title: 'Chat b'
    })
  })

  it('runs a semantic search on Return and closes the keyboard', async () => {
    const search = chatSearch({ query: 'sky' })
    await renderScreen(library(), search)
    const field = screen.getByRole('searchbox', { name: 'Search chats' })
    field.focus()
    fireEvent.submit(field.closest('form')!)
    expect(search.submit).toHaveBeenCalledOnce()
    expect(field).not.toHaveFocus()
  })

  it('clears back to the list', async () => {
    const search = chatSearch({ query: 'sky', results: HITS, status: 'ready' })
    const { update } = await renderScreen(library(), search)
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(search.setQuery).toHaveBeenLastCalledWith('')

    update({ search: chatSearch() })
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
    expect(screen.getAllByRole('region')).toHaveLength(3)
  })

  it('says it is searching until results come', async () => {
    await renderScreen(library(), chatSearch({ query: 'sky' }))
    expect(screen.getByRole('status')).toHaveTextContent('Searching…')
  })

  it('says when nothing matches', async () => {
    await renderScreen(
      library(),
      chatSearch({ query: 'sky', status: 'ready', results: [] })
    )
    expect(screen.getByText('No chats match “sky”')).toBeInTheDocument()
  })

  it('says when the search failed', async () => {
    await renderScreen(
      library(),
      chatSearch({ query: 'sky', status: 'error', results: [] })
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t search')
  })
})

// --- States ---------------------------------------------------------------------

describe('LibraryScreen states', () => {
  it('shows skeleton rows while the list loads', async () => {
    await renderScreen(
      library({ chats: [], total: undefined, status: 'loading' })
    )
    expect(
      screen.getByRole('status', { name: 'Loading chats' })
    ).toBeInTheDocument()
  })

  it('shows skeleton rows while an empty cache revalidates', async () => {
    await renderScreen(library({ chats: [], status: 'refreshing' }))
    expect(
      screen.getByRole('status', { name: 'Loading chats' })
    ).toBeInTheDocument()
  })

  it('shows skeleton rows while the stored sort loads', async () => {
    vi.mocked(Preferences.get).mockReturnValueOnce(new Promise(() => {}))
    vi.mocked(useLibrary).mockReturnValue(library())
    vi.mocked(useChatSearch).mockReturnValue(chatSearch())
    render(
      <StackProvider root={HOME}>
        <LibraryScreen />
      </StackProvider>
    )
    expect(
      screen.getByRole('heading', { level: 1, name: 'Library' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('status', { name: 'Loading chats' })
    ).toBeInTheDocument()
    expect(useLibrary).not.toHaveBeenCalled()
  })

  it('shows "No chats yet" with a way to the Ask tab', async () => {
    await renderScreen(library({ chats: [], total: 0 }))
    expect(screen.getByText('No chats yet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ask a question' }))
    expect(selectTab).toHaveBeenCalledExactlyOnceWith('ask')
  })

  it('shows an error with Retry when there is no cache', async () => {
    const lib = library({
      chats: [],
      total: undefined,
      status: 'error',
      error: 'Network error. Check your connection.'
    })
    await renderScreen(lib)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t load your chats')
    expect(alert).toHaveTextContent('Network error. Check your connection.')
    expect(screen.queryByText('No chats yet')).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(lib.refresh).toHaveBeenCalledOnce()
  })

  it('shows the cached list with an error when refresh fails', async () => {
    const lib = library({
      status: 'error',
      error: 'Network error. Check your connection.'
    })
    await renderScreen(lib)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Network error. Check your connection.')
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(lib.refresh).toHaveBeenCalledOnce()
  })

  it('shows a failed delete or rename over the list', async () => {
    await renderScreen(library({ status: 'ready', error: 'Not allowed' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Not allowed')
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })
})

// --- Rendering cost ---------------------------------------------------------------

describe('LibraryScreen rendering', () => {
  const touch = (y: number) => ({ identifier: 0, clientX: 100, clientY: y })

  it('does not re-render the list or its rows while the list is pulled', async () => {
    await renderScreen()
    const scroller = screen.getByTestId('library-scroll')
    vi.mocked(relativeTime).mockClear()
    vi.mocked(groupByDate).mockClear()

    fireEvent.touchStart(scroller, {
      touches: [touch(100)],
      changedTouches: [touch(100)]
    })
    for (const y of [130, 180, 240, 300]) {
      fireEvent.touchMove(scroller, {
        touches: [touch(y)],
        changedTouches: [touch(y)]
      })
    }
    expect(screen.getByTestId('library-content').style.transform).not.toBe('')
    expect(relativeTime).not.toHaveBeenCalled()
    expect(groupByDate).not.toHaveBeenCalled()
  })

  it('does not re-render the list for a sheet or a blank query', async () => {
    const lib = library()
    const { update } = await renderScreen(lib)
    vi.mocked(relativeTime).mockClear()
    vi.mocked(groupByDate).mockClear()

    swipeAction('Chat b', 'Delete')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    update({ search: chatSearch({ query: ' ' }) })
    update({ search: chatSearch({ query: '   ' }) })

    expect(groupByDate).not.toHaveBeenCalled()
    expect(relativeTime).not.toHaveBeenCalled()
  })

  it('re-renders only the row that changed', async () => {
    const lib = library()
    const { update } = await renderScreen(lib)
    vi.mocked(relativeTime).mockClear()

    const renamed = { ...ROWS[1], title: 'Renamed' }
    update({ lib: { ...lib, chats: [ROWS[0], renamed, ROWS[2]] } })

    expect(rowButton('Renamed')).toBeInTheDocument()
    expect(relativeTime).toHaveBeenCalledOnce()
    expect(vi.mocked(relativeTime).mock.calls[0][0]).toBe(renamed.lastViewedAt)
  })
})

// --- Segments -------------------------------------------------------------------

describe('LibraryScreen segments', () => {
  const segment = (name: 'Chats' | 'Notes') => screen.getByRole('tab', { name })

  const panel = (name: 'Chats' | 'Notes') =>
    document.getElementById(segment(name).getAttribute('aria-controls')!)!

  it('opens on Chats, with Notes beside it', async () => {
    await renderScreen()
    const tabs = within(
      screen.getByRole('tablist', { name: 'Library sections' })
    ).getAllByRole('tab')
    expect(tabs.map(t => t.textContent)).toEqual(['Chats', 'Notes'])
    expect(segment('Chats')).toHaveAttribute('aria-selected', 'true')
    expect(segment('Notes')).toHaveAttribute('aria-selected', 'false')
    expect(rowButton('Chat a')).toBeVisible()
    // Notes are not asked for until the segment is opened.
    expect(useNotes).not.toHaveBeenCalled()
  })

  it('shows the notes on Notes, with a tick, and remembers the choice', async () => {
    await renderScreen()
    fireEvent.click(segment('Notes'))
    expect(segment('Notes')).toHaveAttribute('aria-selected', 'true')
    expect(useNotes).toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: /^Note one/ })
    ).toBeInTheDocument()
    expect(haptic).toHaveBeenCalledWith('selection')
    expect(prefsData.get(LIBRARY_SEGMENT_KEY)).toBe('notes')
    expect(panel('Notes')).not.toHaveAttribute('inert')
    expect(panel('Chats')).toHaveAttribute('inert')
    expect(panel('Chats')).toHaveStyle({ visibility: 'hidden' })
  })

  it('a tap on the shown segment does nothing', async () => {
    await renderScreen()
    fireEvent.click(segment('Chats'))
    expect(haptic).not.toHaveBeenCalled()
    expect(Preferences.set).not.toHaveBeenCalled()
  })

  it('only the segment shown watches its end for the next page', async () => {
    vi.mocked(useNotes).mockReturnValue(notesState({ hasMore: true }))
    await renderScreen(library({ hasMore: true }))
    const chatsEnd = screen.getByTestId('library-more')
    expect(isObserved(chatsEnd)).toBe(true)
    fireEvent.click(segment('Notes'))
    const notesEnd = screen.getByTestId('notes-more')
    expect(isObserved(notesEnd)).toBe(true)
    expect(isObserved(chatsEnd)).toBe(false)
    fireEvent.click(segment('Chats'))
    expect(isObserved(chatsEnd)).toBe(true)
    expect(isObserved(notesEnd)).toBe(false)
  })

  it('opens on the stored segment, loading no chats until Chats is shown', async () => {
    prefsData.set(LIBRARY_SEGMENT_KEY, 'notes')
    vi.mocked(useLibrary).mockReturnValue(library())
    vi.mocked(useChatSearch).mockReturnValue(chatSearch())
    render(
      <StackProvider root={HOME}>
        <LibraryScreen />
      </StackProvider>
    )
    expect(
      await screen.findByRole('button', { name: /^Note one/ })
    ).toBeInTheDocument()
    expect(segment('Notes')).toHaveAttribute('aria-selected', 'true')
    expect(useLibrary).not.toHaveBeenCalled()
    fireEvent.click(segment('Chats'))
    expect(useLibrary).toHaveBeenCalled()
    expect(rowButton('Chat a')).toBeVisible()
  })

  it('switching segments renders neither list again, and each keeps its state', async () => {
    await renderScreen()
    const chatRow = rowButton('Chat a')
    fireEvent.click(segment('Notes'))
    // Each chat list render groups the rows once (the groupByDate spy).
    const chatListRenders = vi.mocked(groupByDate).mock.calls.length
    // Each row render (chat or note) formats its time once.
    const rowRenders = vi.mocked(relativeTime).mock.calls.length
    const noteRenders = vi.mocked(useNotes).mock.calls.length
    fireEvent.click(segment('Chats'))
    fireEvent.click(segment('Notes'))
    fireEvent.click(segment('Chats'))
    expect(vi.mocked(groupByDate).mock.calls.length).toBe(chatListRenders)
    expect(vi.mocked(relativeTime).mock.calls.length).toBe(rowRenders)
    expect(vi.mocked(useNotes).mock.calls.length).toBe(noteRenders)
    // The same row element: the list was kept, not mounted again.
    expect(rowButton('Chat a')).toBe(chatRow)
    expect(panel('Notes')).toHaveAttribute('inert')
  })
})
