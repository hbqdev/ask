// In a file of its own, so the answer renderer has not loaded before this
// test's first render (a module loads once per file).

import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import type { ApiClient } from '@/core/api/client'
import { useAuth, type Auth } from '@/core/auth/AuthProvider'
import { useStack, type Stack } from '@/core/nav/stack'
import type { Note } from '@/features/notes/notes-api'
import { setNotesCache } from '@/features/notes/notes-cache'
import { NoteScreen } from '@/features/notes/NoteScreen'

vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/core/auth/AuthProvider', () => ({ useAuth: vi.fn() }))
vi.mock('@/core/nav/stack', () => ({ useStack: vi.fn() }))
vi.mock('@/features/thread/ThreadScreen', () => ({ openThread: vi.fn() }))

const NOTE: Note = {
  id: 'n1',
  title: 'Tides',
  content: 'The **moon** pulls the sea.',
  chatId: null,
  sourceMessageId: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-21T08:00:00.000Z'
}

it('shows a note’s content as plain text until the renderer has loaded', async () => {
  const client = {
    json: vi.fn(() => new Promise(() => {}))
  } as unknown as ApiClient
  vi.mocked(useApi).mockReturnValue({ client } as Api)
  vi.mocked(useAuth).mockReturnValue({
    session: { user: { id: 'user-1' } }
  } as unknown as Auth)
  vi.mocked(useStack).mockReturnValue({
    push: vi.fn(),
    pop: vi.fn()
  } as unknown as Stack)
  setNotesCache({ userId: 'user-1', notes: [NOTE], nextCursor: null })
  render(<NoteScreen noteId="n1" />)
  expect(screen.getByText(NOTE.content)).toHaveClass('whitespace-pre-wrap')
  // The renderer's chunk is large: give it time to load on a busy machine.
  expect(
    await screen.findByText('moon', {}, { timeout: 10_000 })
  ).toHaveAttribute('data-streamdown', 'strong')
})
