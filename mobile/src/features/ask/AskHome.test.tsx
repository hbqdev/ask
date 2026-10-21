import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { useAuth, type Auth } from '@/core/auth/AuthProvider'
import { StackProvider, StackView, useStack } from '@/core/nav/stack'
import { AskHome } from '@/features/ask/AskHome'
import { SearchSettingsProvider } from '@/features/compose/SearchSettingsProvider'
import { useThread, type ThreadSession } from '@/features/thread/useThread'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@/features/thread/useThread', () => ({ useThread: vi.fn() }))
vi.mock('@/core/auth/AuthProvider', () => ({ useAuth: vi.fn() }))
vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/core/ids', () => ({ newId: vi.fn(() => 'new-chat-id') }))

type UrlOpenListener = (event: { url: string }) => void

const app = vi.hoisted(() => ({
  listeners: [] as Array<(event: { url: string }) => void>
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (_event: string, listener: UrlOpenListener) => {
      app.listeners.push(listener)
      return { remove: vi.fn(async () => {}) }
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

beforeEach(() => {
  vi.clearAllMocks()
  app.listeners.length = 0
  vi.mocked(useThread).mockReturnValue({
    messages: [],
    status: 'ready',
    error: undefined,
    loading: false,
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
    expect(send).toHaveBeenCalledExactlyOnceWith('Why is the sky blue?')
  })

  it('opens a new thread for an ask:// link', async () => {
    renderHome()
    await act(async () => {})

    act(() =>
      app.listeners.forEach(l => l({ url: 'ask://ask?q=from%20a%20link' }))
    )
    expect(screen.getByTestId('keys')).toHaveTextContent(
      'tabs,thread:new-chat-id'
    )
    expect(send).toHaveBeenCalledExactlyOnceWith('from a link')
  })
})
