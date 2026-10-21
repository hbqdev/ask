// The thread screen over the real useThread, with a fake Ask server behind
// the real API client: what the header shows comes from the server's answers.

import { render, screen } from '@testing-library/react'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiProvider } from '@/core/api/ApiProvider'
import { useAuth, type Auth } from '@/core/auth/AuthProvider'
import { StackProvider } from '@/core/nav/stack'
import { SearchSettingsProvider } from '@/features/compose/SearchSettingsProvider'
import { ThreadScreen } from '@/features/thread/ThreadScreen'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@/core/auth/AuthProvider', () => ({ useAuth: vi.fn() }))
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: async () => {} })) }
}))

const BASE = 'https://ask.test.invalid'

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' }
  })

/** A saved chat whose first answer streamed `streamed`; the server now calls it `title`. */
function serveChat(streamed: string, title: string) {
  const messages: UIMessage[] = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'The question' }] },
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'The answer' },
        { type: 'data-title', data: { title: streamed } }
      ]
    }
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/chat/c1/messages') return json({ messages, title })
      return new Response(null, { status: 204 })
    })
  )
}

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({
    getAccessToken: async () => 'token',
    signOut: async () => {}
  } as unknown as Auth)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ThreadScreen with the real useThread', () => {
  it('heads a chat renamed since its title was streamed with the new name', async () => {
    serveChat('Streamed title', 'Renamed title')
    render(
      <ApiProvider baseUrl={BASE}>
        <SearchSettingsProvider storage={memoryStorage()}>
          <StackProvider root={{ key: 'home', render: () => null }}>
            <ThreadScreen chatId="c1" isNew={false} initialTitle="Old title" />
          </StackProvider>
        </SearchSettingsProvider>
      </ApiProvider>
    )

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Renamed title' })
    ).toBeInTheDocument()
    expect(screen.getByText('The answer')).toBeInTheDocument()
  })
})
