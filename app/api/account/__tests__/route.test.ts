import { NextRequest } from 'next/server'

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The route runs the real deleteAccount over a mocked user, DB layer and
// Supabase admin client (never a real one), with uploads in a temp dir.
vi.mock('@/lib/analytics')
vi.mock('@/lib/auth/get-current-user')
vi.mock('@/lib/db/actions')
vi.mock('@/lib/db/memory-actions')
vi.mock('@/lib/storage/r2-client')
vi.mock('@/lib/supabase/admin')

import { getCurrentUser } from '@/lib/auth/get-current-user'
import * as dbActions from '@/lib/db/actions'
import * as memoryDb from '@/lib/db/memory-actions'
import { deleteUserObjects } from '@/lib/storage/r2-client'
import { createAdminClient } from '@/lib/supabase/admin'

import { DELETE } from '../route'

const user = { id: '550e8400-e29b-41d4-a716-446655440000', email: 'a@b.c' }
const deleteUser = vi.fn()

let uploadsDir: string
const userUploads = () => path.join(uploadsDir, user.id)

function del(body?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/account', {
    method: 'DELETE',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body })
  })
}

const CONFIRM = '{"confirm":"DELETE"}'

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubEnv('ENABLE_AUTH', 'true')
  uploadsDir = await mkdtemp(path.join(tmpdir(), 'ask-account-route-test-'))
  vi.stubEnv('UPLOADS_DIR', uploadsDir)
  await mkdir(path.join(userUploads(), 'chats', 'c1'), { recursive: true })
  await writeFile(path.join(userUploads(), 'chats', 'c1', 'a.pdf'), 'x')
  await mkdir(path.join(uploadsDir, 'other-user'), { recursive: true })

  vi.mocked(getCurrentUser).mockResolvedValue(user as any)
  vi.mocked(memoryDb.clearMemories).mockResolvedValue()
  vi.mocked(memoryDb.deleteUserSettings).mockResolvedValue()
  vi.mocked(dbActions.deleteUserChats).mockResolvedValue({ success: true })
  vi.mocked(dbActions.deleteUserNotes).mockResolvedValue({ success: true })
  vi.mocked(dbActions.deleteUserLibraryFiles).mockResolvedValue({
    success: true
  })
  vi.mocked(dbActions.anonymizeUserFeedback).mockResolvedValue({
    success: true
  })
  vi.mocked(deleteUserObjects).mockResolvedValue({
    deletedCount: 0,
    skipped: true
  })
  deleteUser.mockResolvedValue({ data: { user: null }, error: null })
  vi.mocked(createAdminClient).mockReturnValue({
    auth: { admin: { deleteUser } }
  } as any)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(uploadsDir, { recursive: true, force: true })
})

function expectNothingDeleted() {
  expect(memoryDb.clearMemories).not.toHaveBeenCalled()
  expect(memoryDb.deleteUserSettings).not.toHaveBeenCalled()
  expect(dbActions.deleteUserChats).not.toHaveBeenCalled()
  expect(deleteUser).not.toHaveBeenCalled()
  expect(existsSync(userUploads())).toBe(true)
}

describe('DELETE /api/account', () => {
  it('deletes the account with the confirm body and returns {ok:true}', async () => {
    const res = await DELETE(del(CONFIRM))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(memoryDb.clearMemories).toHaveBeenCalledWith(user.id)
    expect(memoryDb.deleteUserSettings).toHaveBeenCalledWith(user.id)
    expect(dbActions.deleteUserChats).toHaveBeenCalledWith(user.id)
    expect(deleteUser).toHaveBeenCalledWith(user.id)
    expect(await readdir(uploadsDir)).toEqual(['other-user'])
  })

  it.each([
    ['no body', undefined],
    ['an empty object', '{}'],
    ['a lowercase confirm', '{"confirm":"delete"}'],
    ['a boolean confirm', '{"confirm":true}'],
    ['an extra key', '{"confirm":"DELETE","userId":"someone-else"}'],
    ['an array', '["DELETE"]'],
    ['a bare string', '"DELETE"'],
    ['null', 'null'],
    ['malformed JSON', '{confirm:DELETE}']
  ])('refuses without the confirm body: %s → 400', async (_label, body) => {
    const res = await DELETE(del(body))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'Send {"confirm":"DELETE"} to delete the account.'
    })
    expect(getCurrentUser).not.toHaveBeenCalled()
    expectNothingDeleted()
  })

  it('returns 409 in anonymous mode', async () => {
    vi.stubEnv('ENABLE_AUTH', 'false')

    const res = await DELETE(del(CONFIRM))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'Account deletion is unavailable in anonymous mode.'
    })
    expectNothingDeleted()
  })

  it('returns 401 without a user', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)

    const res = await DELETE(del(CONFIRM))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expectNothingDeleted()
  })

  it('returns a retryable 500 with a fixed message when a cleanup step fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(memoryDb.clearMemories).mockRejectedValue(new Error('db down'))

    const res = await DELETE(del(CONFIRM))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to delete account',
      retryable: true
    })
    expect(deleteUser).not.toHaveBeenCalled()
    // The step that failed is logged on the server.
    expect(logged).toHaveBeenCalledWith(
      'DELETE /api/account failed:',
      'Failed to delete user memories'
    )
  })

  it('never passes upstream (Supabase or R2) error text to the client', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    deleteUser.mockResolvedValue({
      data: { user: null },
      error: new Error('AuthApiError: db error at supabase.internal:5432')
    })

    const res = await DELETE(del(CONFIRM))

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: 'Failed to delete account', retryable: true })
    expect(JSON.stringify(body)).not.toContain('supabase.internal')
    expect(logged).toHaveBeenCalledWith(
      'DELETE /api/account failed:',
      'AuthApiError: db error at supabase.internal:5432'
    )
  })

  it('hides an R2 failure the same way', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(deleteUserObjects).mockRejectedValue(
      new Error('R2 bucket ask-uploads: AccessDenied')
    )

    const res = await DELETE(del(CONFIRM))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to delete account',
      retryable: true
    })
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('returns a non-retryable 500 when deletion is not configured, without naming the key', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error('SUPABASE_SECRET_KEY is missing')
    })

    const res = await DELETE(del(CONFIRM))

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({
      error: 'Account deletion is not configured on this server.',
      retryable: false
    })
    expect(JSON.stringify(body)).not.toContain('SUPABASE_SECRET_KEY')
    expectNothingDeleted()
  })

  it('returns a retryable 500 when the action itself throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(getCurrentUser).mockRejectedValue(new Error('auth down'))

    const res = await DELETE(del(CONFIRM))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to delete account',
      retryable: true
    })
    expect(deleteUser).not.toHaveBeenCalled()
  })
})
