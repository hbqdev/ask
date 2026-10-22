import { Browser } from '@capacitor/browser'
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
import type { FunctionComponent } from 'react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance
} from 'vitest'

import { Tabs } from '@/app/Tabs'
import { haptic } from '@/core/haptics'
import { StackProvider } from '@/core/nav/stack'
import {
  TOPICS,
  type DiscoverItem,
  type Topic
} from '@/features/discover/discover-api'
import { DISCOVER_TOPIC_KEY } from '@/features/discover/discover-topic'
import { DiscoverRow } from '@/features/discover/DiscoverCard'
import { DiscoverScreen } from '@/features/discover/DiscoverScreen'
import { useDiscover, type Discover } from '@/features/discover/useDiscover'
import { openThread } from '@/features/thread/ThreadScreen'
import { intersect, isObserved } from '@/test/intersection-observer'

vi.mock('@/features/discover/useDiscover', () => ({ useDiscover: vi.fn() }))
vi.mock('@/features/thread/ThreadScreen', () => ({ openThread: vi.fn() }))
vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))
vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(async () => {}) }
}))

// The rows stay the real memoized components, with a spy on what each
// renders, so a test can count row renders.
vi.mock('@/features/discover/DiscoverCard', async importOriginal => {
  const real =
    await importOriginal<typeof import('@/features/discover/DiscoverCard')>()
  const { memo } = await import('react')
  const inner = (real.DiscoverRow as unknown as { type: FunctionComponent })
    .type
  return { ...real, DiscoverRow: memo(vi.fn(inner)) }
})
const rowRenders = () =>
  vi.mocked((DiscoverRow as unknown as { type: () => void }).type)

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

const item = (topic: Topic, n: number): DiscoverItem => ({
  title: `${topic} story ${n}`,
  summary: `What happened in ${topic} story ${n}.`,
  url: `https://news.example.test/${topic}/${n}`,
  thumbnail: `https://img.example.test/${topic}/${n}.jpg`
})

function feed(topic: Topic, over: Partial<Discover> = {}): Discover {
  return {
    items: [1, 2, 3].map(n => item(topic, n)),
    status: 'ready',
    error: undefined,
    hasMore: false,
    loadMore: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    ...over
  }
}

/** Each topic's feed, the same object on every render (as the hook's is). */
let feeds: Map<Topic, Discover>

const HOME = { key: 'tabs', render: () => <DiscoverScreen /> }

/** Every addEventListener call, with the element it was made on. */
let addListener: MockInstance<EventTarget['addEventListener']>

/** Whether `el` listens for touches: the pull to refresh is bound to it. */
const listensForTouch = (el: Element) =>
  addListener.mock.calls.some(
    ([type], i) => type === 'touchstart' && addListener.mock.contexts[i] === el
  )

/**
 * Waits for the feed and then for its effects to have run. The feed shows
 * once the stored topic loads, an update outside act: React puts it on the
 * page at once but runs its effects in a later task, so the page can be
 * there before the pull (and the end-of-feed watch, in the same commit's
 * effects) are bound. The pull's touch listener on the scroller is what
 * says they have run.
 */
async function shown() {
  await screen.findByRole('radiogroup', { name: 'Topics' })
  const scroller = screen.getByTestId('discover-scroll')
  await waitFor(() => expect(listensForTouch(scroller)).toBe(true))
}

/** The screen as the stack's root, once the stored topic has loaded. */
async function renderScreen(tech: Discover = feed('tech')) {
  feeds.set('tech', tech)
  const utils = render(
    <StackProvider root={HOME}>
      <DiscoverScreen />
    </StackProvider>
  )
  await shown()
  return utils
}

/** The screen in the tab shell, beside a Settings tab to switch to. */
async function renderInTabs(tech: Discover) {
  feeds.set('tech', tech)
  render(
    <StackProvider root={HOME}>
      <Tabs
        tabs={[
          {
            id: 'discover',
            label: 'Discover',
            icon: null,
            render: () => <DiscoverScreen />
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
  await shown()
  const user = userEvent.setup()
  return {
    showTab: (name: string) => user.click(screen.getByRole('tab', { name }))
  }
}

const chip = (label: string) => screen.getByRole('radio', { name: label })

const touch = (y: number) => ({ identifier: 0, clientX: 100, clientY: y })

/** Drags the feed down from the top, without letting go. */
function pullDown(scroller: HTMLElement, to = 400) {
  fireEvent.touchStart(scroller, {
    touches: [touch(100)],
    changedTouches: [touch(100)]
  })
  for (const y of [130, 200, to]) {
    fireEvent.touchMove(scroller, {
      touches: [touch(y)],
      changedTouches: [touch(y)]
    })
  }
}

beforeEach(() => {
  prefsData.clear()
  vi.clearAllMocks()
  feeds = new Map()
  addListener = vi.spyOn(EventTarget.prototype, 'addEventListener')
  vi.mocked(useDiscover).mockImplementation(topic => {
    if (!feeds.has(topic)) feeds.set(topic, feed(topic))
    return feeds.get(topic)!
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// --- Topics -------------------------------------------------------------------

describe('DiscoverScreen topics', () => {
  it('waits for the stored topic before loading a feed', async () => {
    let release!: (value: { value: string | null }) => void
    vi.mocked(Preferences.get).mockImplementationOnce(
      () => new Promise(r => (release = r))
    )
    render(
      <StackProvider root={HOME}>
        <DiscoverScreen />
      </StackProvider>
    )
    expect(
      screen.getByRole('heading', { level: 1, name: 'Discover' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('status', { name: 'Loading stories' })
    ).toBeInTheDocument()
    expect(useDiscover).not.toHaveBeenCalled()

    await act(async () => release({ value: 'science' }))
    expect(chip('Science')).toBeChecked()
    expect(useDiscover).toHaveBeenCalled()
    expect(useDiscover).not.toHaveBeenCalledWith('tech')
  })

  it('shows every topic as a chip, in order, with tech chosen by default', async () => {
    await renderScreen()
    const chips = within(
      screen.getByRole('radiogroup', { name: 'Topics' })
    ).getAllByRole('radio')
    expect(chips.map(c => c.textContent)).toEqual(TOPICS.map(t => t.label))
    expect(chip('Tech')).toBeChecked()
    expect(useDiscover).toHaveBeenLastCalledWith('tech')
    expect(screen.getByText('tech story 1')).toBeInTheDocument()
  })

  it('opens on the stored topic, falling back to tech for an invalid one', async () => {
    prefsData.set(DISCOVER_TOPIC_KEY, 'gaming')
    const { unmount } = await renderScreen()
    await waitFor(() => expect(chip('Gaming')).toBeChecked())
    expect(useDiscover).toHaveBeenLastCalledWith('gaming')
    unmount()

    prefsData.set(DISCOVER_TOPIC_KEY, 'not-a-topic')
    await renderScreen()
    expect(chip('Tech')).toBeChecked()
  })

  it('switches the feed to a chosen topic, ticks, and remembers it', async () => {
    await renderScreen()
    const scroller = screen.getByTestId('discover-scroll')
    scroller.scrollTop = 800
    fireEvent.click(chip('Science'))

    expect(chip('Science')).toBeChecked()
    expect(chip('Tech')).not.toBeChecked()
    expect(useDiscover).toHaveBeenLastCalledWith('science')
    expect(screen.getByText('science story 1')).toBeInTheDocument()
    expect(screen.queryByText('tech story 1')).toBeNull()
    expect(haptic).toHaveBeenCalledExactlyOnceWith('selection')
    expect(scroller.scrollTop).toBe(0)
    expect(Preferences.set).toHaveBeenCalledWith({
      key: DISCOVER_TOPIC_KEY,
      value: 'science'
    })
  })

  it('does nothing for a tap on the chosen topic', async () => {
    await renderScreen()
    fireEvent.click(chip('Tech'))
    expect(haptic).not.toHaveBeenCalled()
    expect(Preferences.set).not.toHaveBeenCalled()
  })

  it('scrolls the chip row to show the stored topic', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.textContent === 'Health' ? 900 : 0
      }
    )
    prefsData.set(DISCOVER_TOPIC_KEY, 'health')
    await renderScreen()
    expect(screen.getByRole('radiogroup', { name: 'Topics' }).scrollLeft).toBe(
      884
    )
  })
})

// --- Feed ---------------------------------------------------------------------

describe('DiscoverScreen feed', () => {
  it('leads with a large card, then compact rows', async () => {
    await renderScreen(
      feed('tech', { items: [1, 2, 3, 4].map(n => item('tech', n)) })
    )
    const lead = screen.getByTestId('discover-lead')
    expect(
      within(lead).getByRole('heading', { name: 'tech story 1' })
    ).toBeInTheDocument()
    expect(
      within(lead).getByText('What happened in tech story 1.')
    ).toBeInTheDocument()

    const rows = within(
      screen.getByRole('list', { name: 'More stories' })
    ).getAllByRole('listitem')
    expect(rows.map(r => r.textContent)).toEqual([
      expect.stringContaining('tech story 2'),
      expect.stringContaining('tech story 3'),
      expect.stringContaining('tech story 4')
    ])
    expect(screen.queryByText('What happened in tech story 2.')).toBeNull()
  })

  it('has no rows for a single story', async () => {
    await renderScreen(feed('tech', { items: [item('tech', 1)] }))
    expect(screen.getByTestId('discover-lead')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'More stories' })).toBeNull()
  })

  it('opens a story in the in-app browser', async () => {
    await renderScreen()
    fireEvent.click(screen.getByRole('button', { name: 'tech story 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'tech story 3' }))
    expect(Browser.open).toHaveBeenNthCalledWith(1, {
      url: 'https://news.example.test/tech/1'
    })
    expect(Browser.open).toHaveBeenNthCalledWith(2, {
      url: 'https://news.example.test/tech/3'
    })
    expect(openThread).not.toHaveBeenCalled()
  })

  it('summarizes a story in a new thread that asks at once', async () => {
    await renderScreen()
    fireEvent.click(
      screen.getByRole('button', { name: 'Summarize tech story 2' })
    )
    expect(openThread).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      question: 'Summary: https://news.example.test/tech/2'
    })
    expect(Browser.open).not.toHaveBeenCalled()
  })
})

// --- Paging and refresh -----------------------------------------------------------

describe('DiscoverScreen paging', () => {
  it('loads more when the end of the feed comes into view', async () => {
    const tech = feed('tech', { hasMore: true })
    await renderScreen(tech)
    act(() => intersect(screen.getByTestId('discover-more')))
    expect(tech.loadMore).toHaveBeenCalledOnce()
  })

  it('has no end to watch when there is nothing more', async () => {
    await renderScreen(feed('tech', { hasMore: false }))
    expect(screen.queryByTestId('discover-more')).toBeNull()
  })

  it('does not page while the tab is hidden, and watches again when shown', async () => {
    const tech = feed('tech', { hasMore: true })
    const { showTab } = await renderInTabs(tech)
    const sentinel = screen.getByTestId('discover-more')
    expect(isObserved(sentinel)).toBe(true)

    await showTab('Settings')
    expect(isObserved(sentinel)).toBe(false)
    act(() => intersect(sentinel))
    expect(tech.loadMore).not.toHaveBeenCalled()

    await showTab('Discover')
    expect(isObserved(sentinel)).toBe(true)
    act(() => intersect(sentinel))
    expect(tech.loadMore).toHaveBeenCalledOnce()
  })

  it('refreshes on a pull down from the top', async () => {
    const tech = feed('tech')
    await renderScreen(tech)
    const scroller = screen.getByTestId('discover-scroll')
    pullDown(scroller)
    const content = screen.getByTestId('discover-content')
    expect(content.style.transform).toMatch(/^translate3d\(0, [\d.]+px, 0\)$/)
    expect(content).not.toHaveClass('pull-settle')
    await act(async () =>
      fireEvent.touchEnd(scroller, {
        touches: [],
        changedTouches: [touch(400)]
      })
    )
    expect(tech.refresh).toHaveBeenCalledOnce()
    expect(content).toHaveClass('pull-settle')
  })

  it('refreshes the topic shown after a switch', async () => {
    await renderScreen()
    fireEvent.click(chip('World'))
    const scroller = screen.getByTestId('discover-scroll')
    pullDown(scroller)
    await act(async () =>
      fireEvent.touchEnd(scroller, {
        touches: [],
        changedTouches: [touch(400)]
      })
    )
    expect(feeds.get('world')!.refresh).toHaveBeenCalledOnce()
    expect(feeds.get('tech')!.refresh).not.toHaveBeenCalled()
  })

  it('does not re-render the stories while the feed is pulled', async () => {
    await renderScreen()
    rowRenders().mockClear()
    pullDown(screen.getByTestId('discover-scroll'))
    expect(screen.getByTestId('discover-content').style.transform).not.toBe('')
    expect(rowRenders()).not.toHaveBeenCalled()
  })
})

// --- States -----------------------------------------------------------------------

describe('DiscoverScreen states', () => {
  it.each(['loading', 'refreshing'] as const)(
    'shows skeletons while %s with nothing to show',
    async status => {
      await renderScreen(feed('tech', { items: [], status, hasMore: true }))
      expect(
        screen.getByRole('status', { name: 'Loading stories' })
      ).toBeInTheDocument()
      expect(screen.queryByTestId('discover-more')).toBeNull()
    }
  )

  it('says so, with a retry, when the first load fails', async () => {
    const tech = feed('tech', {
      items: [],
      status: 'error',
      error: 'Network error. Check your connection.'
    })
    await renderScreen(tech)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t load the news')
    expect(alert).toHaveTextContent('Network error. Check your connection.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(tech.retry).toHaveBeenCalledOnce()
    expect(tech.refresh).not.toHaveBeenCalled()
  })

  it('keeps the stories under a banner when a later load fails', async () => {
    const tech = feed('tech', { status: 'error', error: 'Server error (502)' })
    await renderScreen(tech)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Server error (502)')
    expect(screen.getByTestId('discover-lead')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(tech.retry).toHaveBeenCalledOnce()
    expect(tech.refresh).not.toHaveBeenCalled()
  })

  it('says when a topic has no stories, and offers a refresh', async () => {
    const tech = feed('tech', { items: [], hasMore: false })
    await renderScreen(tech)
    expect(screen.getByText('No stories right now')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(tech.refresh).toHaveBeenCalledOnce()
  })

  it('keeps looking when a loaded page added nothing but more may come', async () => {
    const tech = feed('tech', { items: [], hasMore: true })
    await renderScreen(tech)
    expect(screen.queryByText('No stories right now')).toBeNull()
    expect(
      screen.getByRole('status', { name: 'Loading stories' })
    ).toBeInTheDocument()
    act(() => intersect(screen.getByTestId('discover-more')))
    expect(tech.loadMore).toHaveBeenCalledOnce()
  })
})
