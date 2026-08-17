import React from 'react'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => '/library'
}))

// Server actions pull in server-only DB code — stub them; F1 exercises only the
// client search-box state, not delete/clear.
vi.mock('@/lib/actions/chat', () => ({
  clearChats: vi.fn(),
  deleteChat: vi.fn()
}))

import LibraryPage from '../page'

const CHAT = {
  id: 'c1',
  title: 'First chat',
  createdAt: new Date().toISOString()
}

beforeEach(() => {
  push.mockClear()
  // jsdom lacks IntersectionObserver (the infinite-scroll sentinel uses it).
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  // Initial page load resolves with one chat; the search request stays in flight
  // forever so we can clear the box mid-request.
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('/api/chats/search')) {
        return new Promise(() => {}) // never resolves — request stays in flight
      }
      return Promise.resolve({
        json: async () => ({
          chats: [CHAT],
          nextOffset: null,
          badges: {},
          total: 1
        })
      })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LibraryPage search box', () => {
  // F1 regression: clearing the box while a search request is in flight must
  // reset `isSearching`, otherwise the superseded request's `finally` no longer
  // owns the spinner and the library grid stays hidden behind it forever.
  test('clearing the box mid-request restores the chat grid', async () => {
    render(<LibraryPage />)

    // Grid renders once the initial load resolves.
    expect(await screen.findByText('First chat')).toBeInTheDocument()

    const input = screen.getByPlaceholderText(
      'Search your chats…'
    ) as HTMLInputElement

    // Type a query and submit (Enter) — fires the search immediately (no debounce
    // wait). The request never resolves, so we're now stuck in the searching
    // state and the grid is hidden.
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(screen.queryByText('First chat')).not.toBeInTheDocument()
    )

    // Clear the box via the X button while the request is still in flight.
    const clearButton = input.parentElement!.querySelector(
      'button'
    ) as HTMLButtonElement
    fireEvent.click(clearButton)

    // With F1's `setIsSearching(false)`, isSearchMode drops and the grid comes
    // back. Without the fix, `isSearching` stays true and this never appears.
    expect(await screen.findByText('First chat')).toBeInTheDocument()
  })
})
