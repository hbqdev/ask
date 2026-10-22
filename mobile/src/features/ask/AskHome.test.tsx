import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Tabs } from '@/app/Tabs'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { useAuth, type Auth } from '@/core/auth/AuthProvider'
import { StackProvider, StackView, useStack } from '@/core/nav/stack'
import { newId } from '@/core/ids'
import { AskHome } from '@/features/ask/AskHome'
import { uploadFile } from '@/features/compose/upload'
import { SearchSettingsProvider } from '@/features/compose/SearchSettingsProvider'
import { useThread, type ThreadSession } from '@/features/thread/useThread'
import { clippingAncestors } from '@/test/clipping'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@/features/thread/useThread', () => ({ useThread: vi.fn() }))
vi.mock('@/core/auth/AuthProvider', () => ({ useAuth: vi.fn() }))
vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/core/ids', () => ({ newId: vi.fn(() => 'new-chat-id') }))
vi.mock('@/features/compose/upload', () => ({ uploadFile: vi.fn() }))

type AppListener = (event: { url?: string; isActive?: boolean }) => void

const app = vi.hoisted(() => ({
  listeners: [] as Array<{ event: string; listener: AppListener }>
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (event: string, listener: AppListener) => {
      app.listeners.push({ event, listener })
      return { remove: vi.fn(async () => {}) }
    })
  }
}))

// The Share extension's inbox (the native SharedInbox plugin): one item that
// take() hands over once.
const inbox = vi.hoisted(() => ({
  item: null as null | { text: string; createdAt: number },
  take: vi.fn()
}))

vi.mock('@capacitor/core', async importOriginal => {
  const core = await importOriginal<typeof import('@capacitor/core')>()
  return {
    ...core,
    registerPlugin: ((name: string, options?: object) =>
      name === 'SharedInbox'
        ? { take: inbox.take }
        : core.registerPlugin(name, options)) as typeof core.registerPlugin
  }
})

const prefs = vi.hoisted(() => ({ data: new Map<string, string>() }))

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: prefs.data.get(key) ?? null
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      prefs.data.set(key, value)
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      prefs.data.delete(key)
    })
  }
}))

const send = vi.fn()

function Keys() {
  const { screens } = useStack()
  return <output data-testid="keys">{screens.map(s => s.key).join(',')}</output>
}

function renderHome() {
  return render(
    <SearchSettingsProvider storage={memoryStorage()}>
      <StackProvider root={{ key: 'tabs', render: () => <AskHome /> }}>
        <Keys />
        <StackView />
      </StackProvider>
    </SearchSettingsProvider>
  )
}

const openLink = (url: string) =>
  act(() =>
    app.listeners
      .filter(l => l.event === 'appUrlOpen')
      .forEach(l => l.listener({ url }))
  )

/** The app coming back to the foreground. */
const resume = () =>
  act(async () =>
    app.listeners
      .filter(l => l.event === 'appStateChange')
      .forEach(l => l.listener({ isActive: true }))
  )

const share = (text: string, ageMs = 0) => {
  inbox.item = { text, createdAt: Date.now() - ageMs }
}

const homeBox = () => screen.getByRole('textbox', { name: 'Ask a question' })

afterEach(() => {
  vi.unstubAllEnvs()
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(newId).mockImplementation(() => 'new-chat-id')
  app.listeners.length = 0
  prefs.data.clear()
  inbox.item = null
  inbox.take.mockImplementation(async () => {
    const item = inbox.item
    inbox.item = null
    return item ?? {}
  })
  vi.mocked(useThread).mockReturnValue({
    messages: [],
    status: 'ready',
    error: undefined,
    loading: false,
    saved: false,
    send,
    stop: vi.fn(async () => {}),
    retry: vi.fn(),
    retryLast: vi.fn(),
    reload: vi.fn()
  } satisfies ThreadSession)
  vi.mocked(useAuth).mockReturnValue({ signOut: vi.fn() } as unknown as Auth)
  vi.mocked(useApi).mockReturnValue({
    baseUrl: 'https://ask.test.invalid'
  } as Api)
})

describe('AskHome', () => {
  it('shows the mark, "Ask anything" and the composer', () => {
    renderHome()
    expect(screen.getByTestId('orbit-mark')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Ask anything' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: 'Ask a question' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Search mode: Balanced' })
    ).toBeInTheDocument()
  })

  it('nothing clips the composer’s hit areas, up to the screen', () => {
    renderHome()
    for (const name of ['Attach', 'Search mode: Balanced', 'Dictate']) {
      const control = screen.getByRole('button', { name })
      expect(control, name).toHaveClass('hit-target')
      const root = control.closest('.stack-layer')!
      expect(root, name).not.toBeNull()
      expect(clippingAncestors(control, root), name).toEqual([])
    }
  })

  it('opens a new thread that asks the submitted question', async () => {
    const user = userEvent.setup()
    renderHome()
    await user.type(
      screen.getByRole('textbox', { name: 'Ask a question' }),
      'Why is the sky blue?{Enter}'
    )

    expect(screen.getByTestId('keys')).toHaveTextContent(
      'tabs,thread:new-chat-id'
    )
    expect(useThread).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'new-chat-id', isNew: true })
    )
    expect(send).toHaveBeenCalledExactlyOnceWith('Why is the sky blue?', [])
  })

  it('asks with attached files, uploaded under the chat it opens', async () => {
    const user = userEvent.setup()
    let n = 0
    vi.mocked(newId).mockImplementation(() => `id-${++n}`)
    vi.mocked(useApi).mockReturnValue({
      baseUrl: 'https://ask.test.invalid',
      getToken: async () => 'tok'
    } as Api)
    const doc = {
      url: 'https://ask.test.invalid/uploads/u1/chats/id-1/1-a.pdf',
      filename: 'a.pdf',
      mediaType: 'application/pdf'
    }
    vi.mocked(uploadFile).mockResolvedValue({
      ...doc,
      objectKey: 'k',
      status: 'ready'
    })
    renderHome()
    await user.upload(
      screen.getByTestId('pick-files'),
      new File(['%PDF'], 'a.pdf', { type: 'application/pdf' })
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    )
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'id-1' })
    )

    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByTestId('keys')).toHaveTextContent('tabs,thread:id-1')
    expect(send).toHaveBeenCalledExactlyOnceWith('', [doc])

    // The next question gets a chat of its own.
    openLink('ask://ask?q=next')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByTestId('keys')).toHaveTextContent(
      /^tabs,thread:id-(?!1$)\d+$/
    )
  })

  describe('an ask:// link', () => {
    it('puts the question in the box, focused, and sends nothing', async () => {
      renderHome()
      await act(async () => {})

      openLink('ask://ask?q=from%20a%20link')

      expect(homeBox()).toHaveValue('from a link')
      expect(homeBox()).toHaveFocus()
      expect(screen.getByTestId('keys')).toHaveTextContent(/^tabs$/)
      expect(send).not.toHaveBeenCalled()
    })

    it('is sent only when the user taps Send', async () => {
      const user = userEvent.setup()
      renderHome()
      await act(async () => {})
      openLink('ask://ask?q=from%20a%20link')

      await user.click(screen.getByRole('button', { name: 'Send' }))
      expect(screen.getByTestId('keys')).toHaveTextContent(
        'tabs,thread:new-chat-id'
      )
      expect(send).toHaveBeenCalledExactlyOnceWith('from a link', [])
    })

    it('goes back to the Ask home from an open thread', async () => {
      const user = userEvent.setup()
      renderHome()
      await user.type(homeBox(), 'First{Enter}')
      expect(screen.getByTestId('keys')).toHaveTextContent(
        'tabs,thread:new-chat-id'
      )
      send.mockClear()

      openLink('ask://ask?q=second')

      expect(screen.getByTestId('keys')).toHaveTextContent(/^tabs$/)
      expect(homeBox()).toHaveValue('second')
      expect(send).not.toHaveBeenCalled()
    })

    it('switches to the Ask tab', async () => {
      render(
        <SearchSettingsProvider storage={memoryStorage()}>
          <StackProvider
            root={{
              key: 'tabs',
              render: () => (
                <Tabs
                  tabs={[
                    {
                      id: 'ask',
                      label: 'Ask',
                      icon: <svg />,
                      render: () => <AskHome />
                    },
                    {
                      id: 'library',
                      label: 'Library',
                      icon: <svg />,
                      render: () => <p>Library</p>
                    }
                  ]}
                />
              )
            }}
          >
            <StackView />
          </StackProvider>
        </SearchSettingsProvider>
      )
      await act(async () => {})
      act(() => screen.getByRole('tab', { name: 'Library' }).click())

      openLink('ask://ask?q=from%20a%20link')

      expect(screen.getByRole('tab', { name: 'Ask' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      expect(homeBox()).toHaveValue('from a link')
      expect(send).not.toHaveBeenCalled()
    })

    it('opens and sends at once in a simulator E2E build', async () => {
      vi.stubEnv('VITE_E2E_AUTOSEND', 'true')
      renderHome()
      await act(async () => {})

      openLink('ask://ask?q=from%20a%20link')
      await act(async () => {})

      expect(screen.getByTestId('keys')).toHaveTextContent(
        'tabs,thread:new-chat-id'
      )
      expect(send).toHaveBeenCalledExactlyOnceWith('from a link', undefined)
    })
  })

  describe('an item shared from another app (the Share extension)', () => {
    it('consumes the shared item once and prefills the box, focused, unsent', async () => {
      share('Look at this\nhttps://example.com/a')
      renderHome()
      await act(async () => {})

      expect(homeBox()).toHaveValue('Look at this\nhttps://example.com/a')
      expect(homeBox()).toHaveFocus()
      expect(screen.getByTestId('keys')).toHaveTextContent(/^tabs$/)
      expect(send).not.toHaveBeenCalled()

      // Taken once: coming back again finds the inbox empty.
      fireEvent.change(homeBox(), { target: { value: '' } })
      await resume()
      expect(homeBox()).toHaveValue('')
      expect(inbox.take).toHaveBeenCalledTimes(2)
    })

    it('ignores an item shared more than 24 hours ago', async () => {
      share('yesterday’s news', 24 * 60 * 60 * 1000 + 1)
      renderHome()
      await act(async () => {})

      expect(inbox.take).toHaveBeenCalledOnce()
      expect(homeBox()).toHaveValue('')
    })

    it('picks up a new item when the app comes back to the foreground', async () => {
      renderHome()
      await act(async () => {})
      expect(homeBox()).toHaveValue('')

      share('https://example.com/later')
      await resume()

      expect(homeBox()).toHaveValue('https://example.com/later')
      expect(homeBox()).toHaveFocus()
      expect(send).not.toHaveBeenCalled()
    })

    it('adds it on a new line under a question already in the box', async () => {
      const user = userEvent.setup()
      renderHome()
      await act(async () => {})
      await user.type(homeBox(), 'Summarise this:')

      share('https://example.com/article')
      await resume()

      expect(homeBox()).toHaveValue(
        'Summarise this:\nhttps://example.com/article'
      )
      expect(send).not.toHaveBeenCalled()
    })

    it('goes back to the Ask home from an open thread', async () => {
      const user = userEvent.setup()
      renderHome()
      await user.type(homeBox(), 'First{Enter}')
      expect(screen.getByTestId('keys')).toHaveTextContent(
        'tabs,thread:new-chat-id'
      )
      send.mockClear()

      share('shared text')
      await resume()

      expect(screen.getByTestId('keys')).toHaveTextContent(/^tabs$/)
      expect(homeBox()).toHaveValue('shared text')
      expect(send).not.toHaveBeenCalled()
    })

    it('never sends, even in a simulator E2E build', async () => {
      vi.stubEnv('VITE_E2E_AUTOSEND', 'true')
      share('shared text')
      renderHome()
      await act(async () => {})
      await act(async () => {})

      expect(homeBox()).toHaveValue('shared text')
      expect(screen.getByTestId('keys')).toHaveTextContent(/^tabs$/)
      expect(send).not.toHaveBeenCalled()
    })
  })

  describe('the E2E seeded question', () => {
    it('is asked once at start in an E2E build', async () => {
      vi.stubEnv('VITE_E2E_AUTOSEND', 'true')
      prefs.data.set('e2e-ask', 'Seeded question?')
      renderHome()
      await act(async () => {})
      await act(async () => {})

      expect(prefs.data.has('e2e-ask')).toBe(false)
      expect(screen.getByTestId('keys')).toHaveTextContent(
        'tabs,thread:new-chat-id'
      )
      expect(send).toHaveBeenCalledExactlyOnceWith(
        'Seeded question?',
        undefined
      )
    })

    it('is never read in a normal build', async () => {
      const { Preferences } = await import('@capacitor/preferences')
      prefs.data.set('e2e-ask', 'Planted?')
      renderHome()
      await act(async () => {})

      expect(Preferences.get).not.toHaveBeenCalledWith({ key: 'e2e-ask' })
      expect(prefs.data.get('e2e-ask')).toBe('Planted?')
      expect(send).not.toHaveBeenCalled()
    })
  })
})
