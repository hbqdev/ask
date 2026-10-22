import { Share } from '@capacitor/share'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { createApiClient } from '@/core/api/client'
import { useAuth, type Auth } from '@/core/auth/AuthProvider'
import { haptic } from '@/core/haptics'
import { useStack, type ScreenEntry, type Stack } from '@/core/nav/stack'
import type { Note } from '@/features/notes/notes-api'
import {
  getNotesCache,
  resetNotesCache,
  setNotesCache
} from '@/features/notes/notes-cache'
import {
  DELETE_NOTE_ERROR,
  NoteScreen,
  openNote,
  SHARE_NOTE_ERROR
} from '@/features/notes/NoteScreen'
import { preloadAnswerRenderer } from '@/features/thread/components/AssistantTurn'
import { openThread } from '@/features/thread/ThreadScreen'

vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/core/auth/AuthProvider', () => ({ useAuth: vi.fn() }))
vi.mock('@/core/nav/stack', async importOriginal => ({
  ...(await importOriginal<typeof import('@/core/nav/stack')>()),
  useStack: vi.fn()
}))
vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))
vi.mock('@/features/thread/ThreadScreen', () => ({ openThread: vi.fn() }))
vi.mock('@capacitor/share', () => ({
  Share: { share: vi.fn(async () => ({})) }
}))
vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(async () => {}) }
}))

const BASE = 'https://ask.test.invalid'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

const NOTE: Note = {
  id: 'n1',
  title: 'Tides',
  content: 'The **moon** pulls the sea.',
  chatId: 'c1',
  sourceMessageId: 'm1',
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-21T08:00:00.000Z'
}

type Handler = (method: string, path: string) => Response | Promise<Response>

let handle: Handler
const fetchImpl = vi.fn(
  async (input: RequestInfo | URL, init: RequestInit = {}) =>
    handle(init.method ?? 'GET', new URL(String(input)).pathname)
)
const push = vi.fn()
const pop = vi.fn()

/** The default server: the note, and a delete that succeeds. */
const serve =
  (note: Note = NOTE): Handler =>
  method =>
    method === 'DELETE' ? json({ ok: true }) : json({ note })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

function renderNote(noteId = 'n1') {
  return render(<NoteScreen noteId={noteId} />)
}

// The markdown renderer loads once, up front, so no test waits on its chunk
// (NoteScreen.fallback.test.tsx covers the wait).
beforeAll(() => preloadAnswerRenderer(), 30_000)

beforeEach(() => {
  vi.clearAllMocks()
  resetNotesCache()
  handle = serve()
  const client = createApiClient({
    baseUrl: BASE,
    getToken: async () => 'token',
    fetchImpl
  })
  vi.mocked(useApi).mockReturnValue({ client, baseUrl: BASE } as Api)
  vi.mocked(useAuth).mockReturnValue({
    session: { user: { id: 'user-1' } }
  } as unknown as Auth)
  vi.mocked(useStack).mockReturnValue({ push, pop } as unknown as Stack)
  vi.mocked(Share.share).mockReset().mockResolvedValue({})
})

describe('openNote', () => {
  it('pushes the note’s screen', () => {
    const pushed = vi.fn()
    openNote(pushed, NOTE)
    const entry = pushed.mock.calls[0][0] as ScreenEntry
    expect(entry.key).toBe('note:n1')
    render(<>{entry.render()}</>)
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
  })
})

describe('NoteScreen', () => {
  it('shows the title, date and rendered content once loaded', async () => {
    renderNote()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tides' })
    ).toBeInTheDocument()
    expect(document.querySelector('time')).toHaveAttribute(
      'datetime',
      NOTE.updatedAt
    )
    // Rendered as markdown once the renderer has loaded.
    expect(await screen.findByText('moon')).toHaveAttribute(
      'data-streamdown',
      'strong'
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/api/notes/n1`)
  })

  it('shows the cached note at once, before the server answers', () => {
    setNotesCache({ userId: 'user-1', notes: [NOTE], nextCursor: null })
    handle = () => new Promise<Response>(() => {})
    renderNote()
    expect(
      screen.getByRole('heading', { level: 1, name: 'Tides' })
    ).toBeInTheDocument()
  })

  it('never shows another user’s cached note', () => {
    setNotesCache({ userId: 'user-2', notes: [NOTE], nextCursor: null })
    handle = () => new Promise<Response>(() => {})
    renderNote()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
    expect(screen.getByRole('status', { name: 'Loading note' })).toBeVisible()
  })

  it('shows the server’s copy over the cached one', async () => {
    setNotesCache({ userId: 'user-1', notes: [NOTE], nextCursor: null })
    handle = serve({ ...NOTE, title: 'Tides (edited)' })
    renderNote()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tides (edited)' })
    ).toBeInTheDocument()
  })

  it('names an untitled note', async () => {
    handle = serve({ ...NOTE, title: '' })
    renderNote()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Untitled' })
    ).toBeInTheDocument()
  })

  it('goes back', async () => {
    renderNote()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(pop).toHaveBeenCalled()
  })

  it('opens the chat the note came from', async () => {
    renderNote()
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat' }))
    expect(openThread).toHaveBeenCalledWith(push, { chatId: 'c1' })
  })

  it('offers no chat for a note from none', async () => {
    handle = serve({ ...NOTE, chatId: null })
    renderNote()
    await screen.findByRole('heading', { level: 1, name: 'Tides' })
    expect(screen.queryByRole('button', { name: 'Open chat' })).toBeNull()
  })

  it('shares the note’s text', async () => {
    renderNote()
    await screen.findByRole('heading', { level: 1, name: 'Tides' })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    })
    expect(Share.share).toHaveBeenCalledWith({
      title: 'Tides',
      text: NOTE.content
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says nothing when the share sheet is dismissed', async () => {
    vi.mocked(Share.share).mockRejectedValue(new Error('Share canceled'))
    renderNote()
    await screen.findByRole('heading', { level: 1, name: 'Tides' })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says so when sharing fails', async () => {
    vi.mocked(Share.share).mockRejectedValue(new Error('No share'))
    renderNote()
    await screen.findByRole('heading', { level: 1, name: 'Tides' })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent(SHARE_NOTE_ERROR)
  })

  it('deletes after a confirmation, takes it out of the list and goes back', async () => {
    setNotesCache({ userId: 'user-1', notes: [NOTE], nextCursor: null })
    renderNote()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const sheet = screen.getByRole('dialog', { name: 'Delete this note?' })
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }))
    })
    expect(haptic).toHaveBeenCalledWith('warning')
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE}/api/notes/n1`,
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(getNotesCache()!.notes).toEqual([])
    expect(pop).toHaveBeenCalled()
  })

  it('says it is deleting while the delete is on its way', async () => {
    const gate = deferred<Response>()
    handle = method =>
      method === 'DELETE' ? gate.promise : json({ note: NOTE })
    renderNote()
    await screen.findByRole('heading', { level: 1, name: 'Tides' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Delete'
        })
      )
    })
    const button = screen.getByRole('button', { name: 'Deleting' })
    expect(button).toBeDisabled()
    await act(async () => gate.resolve(json({ ok: true })))
    expect(pop).toHaveBeenCalled()
  })

  it('keeps the note out of the list while its delete is on its way, and out of a list loaded meanwhile', async () => {
    setNotesCache({ userId: 'user-1', notes: [NOTE], nextCursor: null })
    const gate = deferred<Response>()
    handle = method =>
      method === 'DELETE' ? gate.promise : json({ note: NOTE })
    renderNote()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Delete'
        })
      )
    })
    expect(getNotesCache()!.notes).toEqual([])
    // A Notes list refresh read before the delete landed.
    act(() =>
      setNotesCache({ userId: 'user-1', notes: [NOTE], nextCursor: null })
    )
    expect(getNotesCache()!.notes).toEqual([])
    await act(async () => gate.resolve(json({ ok: true })))
    expect(pop).toHaveBeenCalled()
  })

  it('a failed delete lets the note show in lists loaded later', async () => {
    renderNote()
    await screen.findByRole('heading', { level: 1, name: 'Tides' })
    handle = () => json({ error: 'Down' }, 503)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Delete'
        })
      )
    })
    setNotesCache({ userId: 'user-1', notes: [NOTE], nextCursor: null })
    expect(getNotesCache()!.notes).toEqual([NOTE])
  })

  it('counts a note already deleted elsewhere as deleted', async () => {
    renderNote()
    await screen.findByRole('heading', { level: 1, name: 'Tides' })
    handle = () => json({ error: 'Not found' }, 404)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Delete'
        })
      )
    })
    expect(pop).toHaveBeenCalled()
  })

  it('stays and says why when the delete fails', async () => {
    setNotesCache({ userId: 'user-1', notes: [NOTE], nextCursor: null })
    renderNote()
    await screen.findByRole('heading', { level: 1, name: 'Tides' })
    handle = () => json({ error: 'Down' }, 503)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Delete'
        })
      )
    })
    expect(pop).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      `${DELETE_NOTE_ERROR} Down`
    )
    expect(getNotesCache()!.notes).toEqual([NOTE])
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled()
  })

  it('says the note is gone when the server no longer has it', async () => {
    setNotesCache({ userId: 'user-1', notes: [NOTE], nextCursor: null })
    handle = () => json({ error: 'Not found' }, 404)
    renderNote()
    expect(
      await screen.findByText('This note was deleted.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
    expect(getNotesCache()!.notes).toEqual([])
    expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
  })

  it('shows a failed load with Retry, which loads it again', async () => {
    let fail = true
    handle = () => (fail ? json({ error: 'Down' }, 503) : json({ note: NOTE }))
    renderNote()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t load this note')
    expect(alert).toHaveTextContent('Down')
    fail = false
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tides' })
    ).toBeInTheDocument()
  })

  it('keeps showing the cached note when revalidating fails', async () => {
    setNotesCache({ userId: 'user-1', notes: [NOTE], nextCursor: null })
    handle = () => json({ error: 'Down' }, 503)
    renderNote()
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled())
    await act(async () => {})
    expect(
      screen.getByRole('heading', { level: 1, name: 'Tides' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says notes aren’t available on a server without accounts', async () => {
    handle = () =>
      json({ error: 'Library is unavailable in anonymous mode.' }, 403)
    renderNote()
    expect(
      await screen.findByText('Notes aren’t available on this server.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('signed out, it shows no cached note', () => {
    setNotesCache({ userId: 'user-1', notes: [NOTE], nextCursor: null })
    vi.mocked(useAuth).mockReturnValue({ session: null } as unknown as Auth)
    handle = () => new Promise<Response>(() => {})
    renderNote()
    expect(screen.getByRole('status', { name: 'Loading note' })).toBeVisible()
  })
})
