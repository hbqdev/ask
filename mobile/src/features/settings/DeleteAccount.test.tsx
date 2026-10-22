import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { ApiError } from '@/core/api/errors'
import { createApiClient } from '@/core/api/client'
import { AuthProvider, useAuth } from '@/core/auth/AuthProvider'
import { AUTH_STORAGE_KEY } from '@/core/auth/supabase'
import { haptic } from '@/core/haptics'
import {
  getModelChoice,
  modelListLoaded,
  modelListMark,
  resetModelChoice
} from '@/features/compose/model-choice'
import { LIBRARY_CACHE_KEY } from '@/features/library/library-cache'
import { getNotesCache, setNotesCache } from '@/features/notes/notes-cache'
import {
  ACCOUNT_DELETED_NOTICE,
  DELETE_ACCOUNT_ERROR,
  DELETE_ACCOUNT_UNAVAILABLE,
  deleteAccount,
  deleteAccountErrorMessage,
  DeleteAccountSheet
} from '@/features/settings/DeleteAccount'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: async () => {} })) }
}))
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async () => ({ value: null })),
    set: vi.fn(),
    remove: vi.fn()
  }
}))

const BASE = 'https://ask.test.invalid'

// Fake values only: no real tokens or accounts.
const session = {
  access_token: 'fake-access-token',
  refresh_token: 'fake-refresh-token',
  expires_at: 4102444800,
  user: { id: 'user-1', email: 'user@example.test' }
} as unknown as Session

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

type Answer = () => Promise<Response>

/** A fake Ask server whose DELETE /api/account answers with `answer`. */
function serve(answer: Answer) {
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).slice(BASE.length)}`
      if (key !== 'DELETE /api/account') {
        throw new Error(`unexpected request ${key}`)
      }
      return answer()
    }
  )
  const client = createApiClient({
    baseUrl: BASE,
    getToken: async () => 'fake-token',
    fetchImpl
  })
  vi.mocked(useApi).mockReturnValue({
    client,
    baseUrl: BASE,
    getToken: async () => 'fake-token'
  } satisfies Api)
  return { client, fetchImpl }
}

/** A Supabase client stand-in whose stored session the server confirms. */
function fakeSupabase() {
  const auth = {
    getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    onAuthStateChange: vi.fn(() => ({
      data: { subscription: { unsubscribe: vi.fn() } }
    })),
    // The auth user is already gone on the server: its sign-out fails.
    signOut: vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
  }
  return { auth, client: { auth } as unknown as SupabaseClient }
}

/** What the shell would show: the auth status and the sign-in notice. */
function AuthProbe() {
  const { status, notice } = useAuth()
  return (
    <p data-testid="auth">
      {status}
      {notice ? `: ${notice}` : ''}
    </p>
  )
}

/** Settings' row, which opens the sheet, inside a real AuthProvider. */
function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <AuthProbe />
      <button type="button" onClick={() => setOpen(true)}>
        Delete account
      </button>
      <DeleteAccountSheet open={open} onClose={() => setOpen(false)} />
    </>
  )
}

async function setup(answer: Answer = async () => json({ ok: true })) {
  const api = serve(answer)
  const supabase = fakeSupabase()
  const storage = memoryStorage({
    [AUTH_STORAGE_KEY]: JSON.stringify(session),
    [LIBRARY_CACHE_KEY]: '{"userId":"user-1"}'
  })
  render(
    <AuthProvider client={supabase.client} storage={storage}>
      <Harness />
    </AuthProvider>
  )
  await waitFor(() => expect(authText()).toBe('signedIn'))
  fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
  return { ...api, supabase, storage }
}

const authText = () => screen.getByTestId('auth').textContent
const dialog = () => screen.getByRole('dialog', { name: 'Delete account?' })
const field = () => screen.getByLabelText('Type DELETE to confirm')
const deleteButton = () =>
  screen.getByRole('button', { name: /^(Delete my account|Deleting…)$/ })
const cancelButton = () => screen.getByRole('button', { name: 'Cancel' })
const type = (text: string) =>
  fireEvent.change(field(), { target: { value: text } })

beforeEach(() => {
  vi.clearAllMocks()
  resetModelChoice()
})

describe('deleteAccount', () => {
  it('sends DELETE /api/account with exactly {confirm:"DELETE"}', async () => {
    const { client, fetchImpl } = serve(async () => json({ ok: true }))
    await deleteAccount(client)
    const init = fetchImpl.mock.calls[0][1]!
    expect(init.method).toBe('DELETE')
    expect(JSON.parse(init.body as string)).toEqual({ confirm: 'DELETE' })
    expect(new Headers(init.headers).get('Content-Type')).toBe(
      'application/json'
    )
  })

  it('rejects with an ApiError for a non-2xx answer', async () => {
    const { client } = serve(async () => json({ error: 'boom' }, 500))
    await expect(deleteAccount(client)).rejects.toMatchObject({ status: 500 })
  })
})

describe('deleteAccountErrorMessage', () => {
  it('says the server can’t delete accounts for a 409', () => {
    expect(deleteAccountErrorMessage(new ApiError(409, 'anon'))).toBe(
      DELETE_ACCOUNT_UNAVAILABLE
    )
  })

  it('gives the fixed message for anything else, never the server’s text', () => {
    for (const err of [
      new ApiError(500, 'relation "chats" does not exist'),
      new ApiError(0, 'Network error'),
      new ApiError(401, 'Unauthorized'),
      new Error('odd')
    ]) {
      expect(deleteAccountErrorMessage(err)).toBe(DELETE_ACCOUNT_ERROR)
    }
  })
})

describe('DeleteAccountSheet', () => {
  it('explains what is deleted first, and labels the field', async () => {
    await setup()
    const sheet = dialog()
    expect(sheet).toHaveAccessibleDescription(
      /chats, notes, memories and uploads/
    )
    expect(sheet).toHaveAccessibleDescription(/can’t be undone/)
    // The explanation is read before the field: focus starts on the sheet.
    expect(sheet).toHaveFocus()
    expect(field()).toHaveAttribute('autocapitalize', 'characters')
    expect(field()).toHaveAttribute('autocorrect', 'off')
  })

  it('does nothing until DELETE is typed', async () => {
    const { fetchImpl } = await setup()
    expect(deleteButton()).toBeDisabled()
    fireEvent.click(deleteButton())
    for (const text of ['delete', 'DELET', 'DELETE!', 'Delete']) {
      type(text)
      expect(deleteButton()).toBeDisabled()
      fireEvent.submit(field().closest('form')!)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(haptic).not.toHaveBeenCalled()

    // Surrounding spaces don't count.
    type('  DELETE ')
    expect(deleteButton()).toBeEnabled()
  })

  it('sends {confirm:"DELETE"} with a warning haptic, and shows the deletion under way', async () => {
    let answer: (res: Response) => void = () => {}
    const { fetchImpl } = await setup(
      () => new Promise<Response>(resolve => (answer = resolve))
    )
    type('DELETE')
    fireEvent.click(deleteButton())

    expect(haptic).toHaveBeenCalledExactlyOnceWith('warning')
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    const init = fetchImpl.mock.calls[0][1]!
    expect(JSON.parse(init.body as string)).toEqual({ confirm: 'DELETE' })

    // Under way: shown at once, not sent twice, and nothing closes the sheet.
    expect(deleteButton()).toHaveTextContent('Deleting…')
    expect(deleteButton()).toHaveAttribute('aria-busy', 'true')
    expect(deleteButton()).toHaveAttribute('aria-disabled', 'true')
    expect(cancelButton()).toBeDisabled()
    expect(field()).toHaveAttribute('readonly')
    fireEvent.click(deleteButton())
    fireEvent.click(screen.getByTestId('sheet-backdrop'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialog()).toBeInTheDocument()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    await act(async () => answer(json({ ok: true })))
  })

  it('success signs out, clears the caches and says the account was deleted', async () => {
    modelListLoaded('ollama:qwen3', modelListMark())
    setNotesCache({ userId: 'user-1', notes: [], nextCursor: null })
    const { supabase, storage } = await setup()

    type('DELETE')
    fireEvent.click(deleteButton())

    await waitFor(() =>
      expect(authText()).toBe(`signedOut: ${ACCOUNT_DELETED_NOTICE}`)
    )
    expect(ACCOUNT_DELETED_NOTICE).toBe('Your account was deleted')
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    // The server sign-out failed, so the app removed the session itself.
    expect(storage.data.has(AUTH_STORAGE_KEY)).toBe(false)
    await waitFor(() => expect(storage.data.has(LIBRARY_CACHE_KEY)).toBe(false))
    expect(getNotesCache()).toBeNull()
    expect(getModelChoice().selected).toBe('')
  })

  it('stays signed in when the server fails', async () => {
    const { supabase, storage } = await setup(async () =>
      json(
        { error: 'delete from "chats" failed: deadlock', retryable: true },
        500
      )
    )
    type('DELETE')
    fireEvent.click(deleteButton())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      DELETE_ACCOUNT_ERROR
    )
    expect(screen.queryByText(/deadlock/)).toBeNull()
    expect(authText()).toBe('signedIn')
    expect(supabase.auth.signOut).not.toHaveBeenCalled()
    expect(storage.data.has(AUTH_STORAGE_KEY)).toBe(true)
    // The sheet stays open, ready to try again.
    expect(dialog()).toBeInTheDocument()
    expect(deleteButton()).toHaveTextContent('Delete my account')
    expect(deleteButton()).not.toHaveAttribute('aria-disabled')
    expect(cancelButton()).toBeEnabled()
  })

  it('stays signed in when the network fails, and a retry can succeed', async () => {
    const answers: Answer[] = [
      async () => {
        throw new TypeError('Failed to fetch')
      },
      async () => json({ ok: true })
    ]
    await setup(() => answers.shift()!())
    type('DELETE')
    fireEvent.click(deleteButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      DELETE_ACCOUNT_ERROR
    )
    expect(authText()).toBe('signedIn')

    fireEvent.click(deleteButton())
    // The old message goes as the retry starts.
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() =>
      expect(authText()).toBe(`signedOut: ${ACCOUNT_DELETED_NOTICE}`)
    )
  })

  it('409 in anonymous mode shows "Not available on this server"', async () => {
    await setup(async () =>
      json({ error: 'Account deletion is unavailable in anonymous mode.' }, 409)
    )
    type('DELETE')
    fireEvent.click(deleteButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not available on this server'
    )
    expect(DELETE_ACCOUNT_UNAVAILABLE).toBe('Not available on this server')
    expect(authText()).toBe('signedIn')
  })

  it('Cancel closes the sheet and deletes nothing; reopening starts empty', async () => {
    const { fetchImpl } = await setup()
    type('DELETE')
    fireEvent.click(cancelButton())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    expect(field()).toHaveValue('')
    expect(deleteButton()).toBeDisabled()
  })

  it('the backdrop and Escape close it when nothing is under way', async () => {
    await setup()
    fireEvent.click(screen.getByTestId('sheet-backdrop'))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
