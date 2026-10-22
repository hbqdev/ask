import { NextRequest } from 'next/server'

import { beforeEach, describe, expect, it, vi } from 'vitest'

// The route runs the real set/get actions over a mocked user and DB layer.
vi.mock('@/lib/auth/get-current-user')
vi.mock('@/lib/db/memory-actions')
vi.mock('@/lib/db/recall-actions')
vi.mock('@/lib/memory/recall-backfill')

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import * as memoryDb from '@/lib/db/memory-actions'
import * as recallDb from '@/lib/db/recall-actions'

import { PUT } from '../route'

function put(body: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/settings/memory', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body
  })
}

// The stored toggles: writes update them, reads return them.
let stored: { memory: boolean; recall: boolean }

beforeEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  stored = { memory: true, recall: true }
  vi.mocked(getCurrentUserId).mockResolvedValue('user-1')
  vi.mocked(memoryDb.setMemoryEnabled).mockImplementation(async (_u, on) => {
    stored.memory = on
  })
  vi.mocked(recallDb.setRecallEnabled).mockImplementation(async (_u, on) => {
    stored.recall = on
  })
  vi.mocked(memoryDb.isMemoryEnabled).mockImplementation(
    async () => stored.memory
  )
  vi.mocked(recallDb.isRecallEnabled).mockImplementation(
    async () => stored.recall
  )
})

describe('PUT /api/settings/memory', () => {
  it('sets both toggles and returns the stored values', async () => {
    const res = await PUT(put('{"memoryEnabled":false,"recallEnabled":false}'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      enabled: false,
      recallEnabled: false
    })
    expect(memoryDb.setMemoryEnabled).toHaveBeenCalledWith('user-1', false)
    expect(recallDb.setRecallEnabled).toHaveBeenCalledWith('user-1', false)
  })

  it('sets only memory when only memoryEnabled is given', async () => {
    const res = await PUT(put('{"memoryEnabled":false}'))

    expect(await res.json()).toEqual({
      ok: true,
      enabled: false,
      recallEnabled: true
    })
    expect(recallDb.setRecallEnabled).not.toHaveBeenCalled()
  })

  it('sets only recall when only recallEnabled is given', async () => {
    const res = await PUT(put('{"recallEnabled":false}'))

    expect(await res.json()).toEqual({
      ok: true,
      enabled: true,
      recallEnabled: false
    })
    expect(memoryDb.setMemoryEnabled).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty object', '{}'],
    ['only unknown keys', '{"enabled":true}'],
    ['a string memoryEnabled', '{"memoryEnabled":"false"}'],
    ['a numeric recallEnabled', '{"recallEnabled":0}'],
    ['a null memoryEnabled', '{"memoryEnabled":null}'],
    [
      'one valid and one wrong-typed key',
      '{"memoryEnabled":true,"recallEnabled":"no"}'
    ],
    ['an array', '[true]'],
    ['null', 'null'],
    ['malformed JSON', '{memoryEnabled:true']
  ])('returns 400 and writes nothing for %s', async (_label, body) => {
    const res = await PUT(put(body))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid memory settings' })
    expect(memoryDb.setMemoryEnabled).not.toHaveBeenCalled()
    expect(recallDb.setRecallEnabled).not.toHaveBeenCalled()
  })

  it('returns 401 without a user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

    const res = await PUT(put('{"memoryEnabled":true}'))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expect(memoryDb.setMemoryEnabled).not.toHaveBeenCalled()
  })

  it('returns a retryable 500 when a write fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(recallDb.setRecallEnabled).mockRejectedValue(new Error('db'))

    const res = await PUT(put('{"recallEnabled":false}'))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to update memory settings',
      retryable: true
    })
    expect(error).toHaveBeenCalled()
  })
})
