import type { UIMessage } from 'ai'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode, type ReactNode } from 'react'
import { Share } from '@capacitor/share'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { useAuth, type Auth } from '@/core/auth/AuthProvider'
import { StackProvider, StackView, useStack } from '@/core/nav/stack'
import { SEARCH_SETTINGS_KEY } from '@/features/compose/search-settings'
import { SearchSettingsProvider } from '@/features/compose/SearchSettingsProvider'
import type { ChatErrorView } from '@/features/thread/model/chat-errors'
import { openThread, ThreadScreen } from '@/features/thread/ThreadScreen'
import { useThread, type ThreadSession } from '@/features/thread/useThread'
import { memoryStorage } from '@/test/memory-storage'
import { resize } from '@/test/resize-observer'

vi.mock('@/features/thread/useThread', () => ({ useThread: vi.fn() }))
vi.mock('@/core/auth/AuthProvider', () => ({ useAuth: vi.fn() }))
vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/core/ids', () => ({ newId: vi.fn(() => 'new-chat-id') }))
// A plain function, not vi.fn: a mock records each promise it returns, which
// would mark a rejection as handled and hide the bug the test looks for.
const preload = vi.hoisted(() => ({
  calls: 0,
  fail: undefined as Error | undefined
}))
vi.mock('@/features/thread/components/AssistantTurn', async importOriginal => {
  const real =
    await importOriginal<
      typeof import('@/features/thread/components/AssistantTurn')
    >()
  return {
    ...real,
    preloadAnswerRenderer: () => {
      preload.calls++
      const fail = preload.fail
      preload.fail = undefined
      return fail ? Promise.reject(fail) : real.preloadAnswerRenderer()
    }
  }
})
vi.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: vi.fn(async () => {}) }
}))
vi.mock('@capacitor/share', () => ({
  Share: { share: vi.fn(async () => ({})) }
}))
vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(async () => {}) }
}))

type Part = UIMessage['parts'][number]

const BASE = 'https://ask.test.invalid'
const signOut = vi.fn(async () => {})

// --- Fixtures ----------------------------------------------------------------

const user = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }]
})

const searchPart = {
  type: 'tool-search',
  toolCallId: 'call_a',
  state: 'output-available',
  input: { query: 'facts' },
  output: {
    state: 'complete',
    query: 'facts',
    images: [],
    results: [{ title: 'Page A', url: 'https://example.com/a', content: 'a' }]
  }
} as Part

const RELATED = [
  '```spec',
  JSON.stringify({ op: 'add', path: '/root', value: 'q1' }),
  JSON.stringify({
    op: 'add',
    path: '/elements/q1',
    value: {
      type: 'Button',
      props: { text: 'Tell me more?' },
      on: {
        press: { action: 'submitQuery', params: { query: 'Tell me more?' } }
      },
      children: []
    }
  }),
  '```'
].join('\n')

const assistant = (id: string, text: string, parts: Part[] = []) =>
  ({
    id,
    role: 'assistant',
    parts: [...parts, { type: 'text', text }]
  }) as UIMessage

const TURN = [
  user('u1', 'What is the fact?'),
  assistant('a1', `## Answer\n\nThe fact [1](#call_a).\n\n${RELATED}`, [
    searchPart
  ])
]

function session(over: Partial<ThreadSession> = {}): ThreadSession {
  return {
    messages: [],
    status: 'ready',
    error: undefined,
    title: undefined,
    loading: false,
    send: vi.fn(),
    stop: vi.fn(async () => {}),
    retry: vi.fn(),
    retryLast: vi.fn(),
    reload: vi.fn(),
    ...over
  }
}

const HOME = { key: 'home', render: () => <p>Home</p> }

function Shell({ children }: { children: ReactNode }) {
  return (
    <SearchSettingsProvider storage={memoryStorage()}>
      <StackProvider root={HOME}>{children}</StackProvider>
    </SearchSettingsProvider>
  )
}

/** The screen on its own (re-renderable), over a stack and shared settings. */
function renderScreen(
  thread: ThreadSession,
  props: Partial<Parameters<typeof ThreadScreen>[0]> = {}
) {
  vi.mocked(useThread).mockReturnValue(thread)
  const ui = () => (
    <Shell>
      <ThreadScreen chatId="c1" isNew={false} {...props} />
    </Shell>
  )
  const utils = render(ui())
  return {
    ...utils,
    update(next: ThreadSession) {
      vi.mocked(useThread).mockReturnValue(next)
      utils.rerender(ui())
    }
  }
}

const composer = () => screen.getByRole('textbox', { name: 'Ask a follow-up' })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useAuth).mockReturnValue({ signOut } as unknown as Auth)
  vi.mocked(useApi).mockReturnValue({ baseUrl: BASE } as Api)
})

// --- openThread --------------------------------------------------------------

function Opener({ o }: { o: Parameters<typeof openThread>[1] }) {
  const { push, screens } = useStack()
  return (
    <>
      <button type="button" onClick={() => openThread(push, o)}>
        Open
      </button>
      <output data-testid="keys">{screens.map(s => s.key).join(',')}</output>
    </>
  )
}

function renderStack(o: Parameters<typeof openThread>[1]) {
  return render(
    <SearchSettingsProvider storage={memoryStorage()}>
      <StackProvider root={HOME}>
        <Opener o={o} />
        <StackView />
      </StackProvider>
    </SearchSettingsProvider>
  )
}

describe('openThread', () => {
  it('pushes a new chat that sends the question', async () => {
    const thread = session()
    vi.mocked(useThread).mockReturnValue(thread)
    renderStack({ question: 'Why is the sky blue?' })
    await act(async () => screen.getByRole('button', { name: 'Open' }).click())

    expect(screen.getByTestId('keys')).toHaveTextContent(
      'home,thread:new-chat-id'
    )
    expect(useThread).toHaveBeenCalledWith({
      chatId: 'new-chat-id',
      isNew: true,
      settings: { searchMode: 'balanced', sources: ['web'] }
    })
    expect(thread.send).toHaveBeenCalledExactlyOnceWith('Why is the sky blue?')
  })

  it('opens an existing chat without sending anything', async () => {
    const thread = session()
    vi.mocked(useThread).mockReturnValue(thread)
    renderStack({ chatId: 'saved-1' })
    await act(async () => screen.getByRole('button', { name: 'Open' }).click())

    expect(screen.getByTestId('keys')).toHaveTextContent('home,thread:saved-1')
    expect(useThread).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'saved-1', isNew: false })
    )
    expect(thread.send).not.toHaveBeenCalled()
  })

  it('goes back with the back button', async () => {
    vi.mocked(useThread).mockReturnValue(session({ messages: TURN }))
    renderStack({ chatId: 'saved-1' })
    await act(async () => screen.getByRole('button', { name: 'Open' }).click())

    await act(async () => screen.getByRole('button', { name: 'Back' }).click())
    expect(screen.getByTestId('keys')).toHaveTextContent(/^home$/)
  })
})

// --- ThreadScreen ------------------------------------------------------------

describe('ThreadScreen', () => {
  it('sends the initial question exactly once, even when mounted twice', () => {
    const thread = session()
    vi.mocked(useThread).mockReturnValue(thread)
    render(
      <StrictMode>
        <Shell>
          <ThreadScreen chatId="c1" isNew initialQuestion="First?" />
        </Shell>
      </StrictMode>
    )
    expect(thread.send).toHaveBeenCalledExactlyOnceWith('First?')
  })

  it('reads the settings the app shares', async () => {
    vi.mocked(useThread).mockReturnValue(session())
    const storage = memoryStorage({
      [SEARCH_SETTINGS_KEY]: JSON.stringify({
        searchMode: 'quality',
        sources: ['academic']
      })
    })
    render(
      <SearchSettingsProvider storage={storage}>
        <StackProvider root={HOME}>
          <ThreadScreen chatId="c1" isNew />
        </StackProvider>
      </SearchSettingsProvider>
    )
    await act(async () => {})
    expect(vi.mocked(useThread).mock.calls.at(-1)?.[0].settings).toEqual({
      searchMode: 'quality',
      sources: ['academic']
    })
    expect(
      screen.getByRole('button', { name: 'Search mode: Quality' })
    ).toBeInTheDocument()
  })

  it('survives a failed preload of the answer renderer', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    preload.calls = 0
    preload.fail = new Error('Failed to fetch dynamically imported module')
    renderScreen(session())
    await act(() => new Promise(resolve => setTimeout(resolve, 10)))
    process.off('unhandledRejection', unhandled)

    expect(preload.calls).toBe(1)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('shows only the text of a question with other parts', async () => {
    const userEv = userEvent.setup()
    const question = {
      id: 'u1',
      role: 'user',
      parts: [
        {
          type: 'file',
          mediaType: 'image/png',
          url: 'https://ask.test.invalid/uploads/a.png'
        },
        { type: 'text', text: 'What is in this picture?' }
      ]
    } as UIMessage
    renderScreen(
      session({ messages: [question, assistant('a1', 'A red fox.')] })
    )
    expect(
      screen.getByText('What is in this picture?', { selector: 'p' })
    ).toBeVisible()

    // The answer is shared under its question's text.
    await userEv.click(screen.getByRole('button', { name: 'Share' }))
    expect(Share.share).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'What is in this picture?' })
    )
  })

  it('shares an answer with no question before it untitled', async () => {
    const userEv = userEvent.setup()
    renderScreen(session({ messages: [assistant('a1', 'Hello.')] }))

    await userEv.click(screen.getByRole('button', { name: 'Share' }))
    expect(Share.share).toHaveBeenCalledWith(
      expect.objectContaining({ title: '' })
    )
  })

  it('shows the question and the answer of each turn', async () => {
    renderScreen(session({ messages: TURN }))
    expect(
      screen.getByText('What is the fact?', { selector: 'p' })
    ).toBeVisible()
    expect(
      await screen.findByRole('heading', { name: 'Answer' })
    ).toBeInTheDocument()
    expect(screen.getByText(/The fact/)).toBeInTheDocument()
  })

  it('heads the screen with the chat title', () => {
    renderScreen(session({ messages: TURN, title: 'Facts, explained' }))
    expect(
      screen.getByRole('heading', { level: 1, name: 'Facts, explained' })
    ).toBeInTheDocument()
  })

  it('falls back to the first question, then the question being sent', () => {
    const { unmount } = renderScreen(session({ messages: TURN }))
    expect(
      screen.getByRole('heading', { level: 1, name: 'What is the fact?' })
    ).toBeInTheDocument()
    unmount()

    renderScreen(session(), { isNew: true, initialQuestion: 'Pending?' })
    expect(
      screen.getByRole('heading', { level: 1, name: 'Pending?' })
    ).toBeInTheDocument()
  })

  it('heads a chat with nothing loaded yet "Chat"', () => {
    renderScreen(session({ loading: true }))
    expect(
      screen.getByRole('heading', { level: 1, name: 'Chat' })
    ).toBeInTheDocument()
  })

  it('lists the latest answer’s sources from the header', async () => {
    const userEv = userEvent.setup()
    renderScreen(session({ messages: TURN }))
    await userEv.click(screen.getByRole('button', { name: 'Sources' }))

    const sheet = screen.getByRole('dialog', { name: 'Sources' })
    expect(within(sheet).getByText('Page A')).toBeInTheDocument()

    await userEv.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('disables the header’s Sources button while there are none', () => {
    renderScreen(session({ messages: [user('u1', 'Hi')] }))
    expect(screen.getByRole('button', { name: 'Sources' })).toBeDisabled()
  })

  it('sends a follow-up from the composer', async () => {
    const userEv = userEvent.setup()
    const thread = session({ messages: TURN })
    renderScreen(thread)
    await userEv.type(composer(), 'And then?{Enter}')
    expect(thread.send).toHaveBeenCalledExactlyOnceWith('And then?')
  })

  it('asks a related question with send', () => {
    const thread = session({ messages: TURN })
    renderScreen(thread)
    fireEvent.click(screen.getByRole('button', { name: 'Tell me more?' }))
    expect(thread.send).toHaveBeenCalledWith('Tell me more?')
  })

  it('retries one answer from its actions', () => {
    const thread = session({ messages: TURN })
    renderScreen(thread)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(thread.retry).toHaveBeenCalledWith('a1')
  })

  it('stops a streaming turn from the composer', () => {
    const thread = session({ messages: TURN, status: 'streaming' })
    renderScreen(thread)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(thread.stop).toHaveBeenCalledTimes(1)
    // The streaming turn has no actions yet.
    expect(
      screen.queryByRole('button', { name: 'Retry' })
    ).not.toBeInTheDocument()
  })

  it('shows that an answer is coming before its first part arrives', () => {
    renderScreen(session({ messages: [user('u1', 'Hi')], status: 'submitted' }))
    expect(screen.getByRole('status', { name: 'Thinking' })).toBeInTheDocument()
  })

  it('shows a skeleton while the chat loads, and cannot send yet', async () => {
    const userEv = userEvent.setup()
    const thread = session({ loading: true })
    renderScreen(thread)
    expect(
      screen.getByRole('status', { name: 'Loading chat' })
    ).toBeInTheDocument()

    await userEv.type(composer(), 'Early{Enter}')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(thread.send).not.toHaveBeenCalled()
  })

  describe('error banner', () => {
    const error = (over: Partial<ChatErrorView> = {}): ChatErrorView => ({
      message: 'The model is busy',
      retryable: true,
      authRequired: false,
      ...over
    })

    it('shows the message, and Retry calls retryLast only', () => {
      const thread = session({ messages: TURN, error: error() })
      renderScreen(thread)
      const banner = screen.getByRole('alert')
      expect(banner).toHaveTextContent('The model is busy')

      fireEvent.click(within(banner).getByRole('button', { name: 'Retry' }))
      expect(thread.retryLast).toHaveBeenCalledTimes(1)
      expect(thread.retry).not.toHaveBeenCalled()
    })

    it('offers no Retry for an error that cannot be retried', () => {
      renderScreen(session({ error: error({ retryable: false }) }))
      const banner = screen.getByRole('alert')
      expect(within(banner).queryByRole('button')).not.toBeInTheDocument()
    })

    it('offers "Sign in again" instead of Retry when signed out', () => {
      renderScreen(
        session({
          error: error({
            message: 'Signed out',
            retryable: false,
            authRequired: true
          })
        })
      )
      const banner = screen.getByRole('alert')
      expect(
        within(banner).queryByRole('button', { name: 'Retry' })
      ).not.toBeInTheDocument()

      fireEvent.click(
        within(banner).getByRole('button', { name: 'Sign in again' })
      )
      expect(signOut).toHaveBeenCalledTimes(1)
    })
  })

  describe('following the answer', () => {
    /**
     * Scroll metrics for the thread's scroller, which jsdom doesn't lay out.
     * Like a browser, scrollTop stays within 0..scrollHeight - clientHeight.
     */
    function metrics(el: HTMLElement, height: number, client: number) {
      let top = 0
      let scrollHeight = height
      let clientHeight = client
      const clamp = (v: number) =>
        Math.max(0, Math.min(v, scrollHeight - clientHeight))
      Object.defineProperty(el, 'scrollHeight', {
        configurable: true,
        get: () => scrollHeight
      })
      Object.defineProperty(el, 'clientHeight', {
        configurable: true,
        get: () => clientHeight
      })
      Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (v: number) => {
          top = clamp(v)
        }
      })
      return {
        /** The content's height changes; no React render, no scroll event. */
        grow(h: number) {
          scrollHeight = h
        },
        /** The visible height changes (the keyboard opens or closes). */
        setClient(h: number) {
          clientHeight = h
          top = clamp(top)
        },
        /** The browser moves the scroll position on its own (a clamp). */
        clampTo(v: number) {
          top = v
        },
        /** A scroll event at the current position. */
        fire() {
          fireEvent.scroll(el)
        },
        /** The user scrolls to `v`. */
        scrollTo(v: number) {
          top = clamp(v)
          fireEvent.scroll(el)
        },
        top: () => top
      }
    }

    const scroller = () => screen.getByTestId('thread-scroll')
    const content = () => screen.getByTestId('thread-content')
    const jump = () => screen.queryByRole('button', { name: 'Jump to latest' })
    const more = (n: number, status: ThreadSession['status'] = 'streaming') =>
      session({
        status,
        messages: [
          ...TURN,
          user('u2', 'More?'),
          assistant('a2', `## More\n\n${'word '.repeat(n)}`)
        ]
      })

    /** The screen streaming, its scroller pinned to the bottom of 1000 px. */
    function pinned() {
      const view = renderScreen(more(1))
      const m = metrics(scroller(), 1000, 500)
      m.scrollTo(500)
      return { view, m }
    }

    it('keeps the newest text in view while streaming', () => {
      const { view, m } = pinned()

      m.grow(1400)
      view.update(more(2))
      expect(m.top()).toBe(900)
      expect(jump()).not.toBeInTheDocument()
    })

    it('keeps following when content grows after the pin (not a user scroll)', () => {
      const { m } = pinned()

      // The answer renderer commits its blocks after React's update: the
      // content grows with no render of this screen.
      m.grow(1400)
      act(() => resize(content()))
      expect(m.top()).toBe(900)

      // The scroll event the pin causes is not the user's.
      m.fire()
      expect(jump()).not.toBeInTheDocument()
      m.grow(1800)
      act(() => resize(content()))
      expect(m.top()).toBe(1300)
    })

    it('keeps following through a shrink the browser clamps', () => {
      const { m } = pinned()

      // The content shrinks a little: the browser clamps scrollTop up to the
      // new bottom and fires a scroll event.
      m.grow(965)
      m.clampTo(465)
      m.fire()
      expect(jump()).not.toBeInTheDocument()

      // Clamped again, but the content regrows before the event arrives:
      // the move up is still the browser's, not the user's.
      m.grow(930)
      m.clampTo(430)
      m.grow(2543)
      m.fire()
      expect(jump()).not.toBeInTheDocument()
      act(() => resize(content()))
      expect(m.top()).toBe(2043)
    })

    it('stops following when the user scrolls up mid-stream', () => {
      const { view, m } = pinned()

      m.scrollTo(300)
      expect(jump()).toBeInTheDocument()

      m.grow(1400)
      act(() => resize(content()))
      view.update(more(2))
      expect(m.top()).toBe(300)
      expect(jump()).toBeInTheDocument()
    })

    it('keeps following when scrolled up by no more than 80 px', () => {
      const { view, m } = pinned()
      m.scrollTo(420)
      expect(jump()).not.toBeInTheDocument()

      m.grow(1400)
      view.update(more(2))
      expect(m.top()).toBe(900)
    })

    it('re-pins when the scroller itself resizes (the keyboard opens)', () => {
      const { m } = pinned()

      m.setClient(200)
      act(() => resize(scroller()))
      expect(m.top()).toBe(800)
      expect(jump()).not.toBeInTheDocument()
    })

    it('does not re-pin on a resize while the user reads above', () => {
      const { m } = pinned()
      m.scrollTo(100)

      m.setClient(200)
      act(() => resize(scroller()))
      expect(m.top()).toBe(100)
      expect(jump()).toBeInTheDocument()
    })

    it('drops "Jump to latest" once nothing is below the fold', () => {
      const { m } = pinned()
      m.scrollTo(0)
      expect(jump()).toBeInTheDocument()

      // The content shrinks to fit: nothing left to jump to.
      m.grow(450)
      act(() => resize(content()))
      expect(jump()).not.toBeInTheDocument()
    })

    it('jumps back on request', () => {
      const { view, m } = pinned()
      m.scrollTo(300)

      m.grow(1400)
      view.update(more(2))
      fireEvent.click(jump()!)
      expect(m.top()).toBe(900)
      expect(jump()).not.toBeInTheDocument()

      // And follows again from there.
      m.grow(1800)
      act(() => resize(content()))
      expect(m.top()).toBe(1300)
    })

    it('follows again after the user sends a follow-up', async () => {
      const userEv = userEvent.setup()
      const view = renderScreen(more(1, 'ready'))
      const m = metrics(scroller(), 1000, 500)
      m.scrollTo(500)
      m.scrollTo(100)
      expect(jump()).toBeInTheDocument()
      await userEv.type(composer(), 'Again{Enter}')
      expect(jump()).not.toBeInTheDocument()

      m.grow(1600)
      view.update(more(3))
      expect(m.top()).toBe(1100)
    })
  })
})
