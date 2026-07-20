import { NextRequest } from 'next/server'

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Auto-mocked; each test configures the resolved values it needs.
vi.mock('@/lib/auth/get-current-user')
vi.mock('@/lib/db/file-actions')

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { getFileStatusesForUser } from '@/lib/db/file-actions'

import { GET } from '../status/route'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCurrentUserId).mockResolvedValue('u1')
  vi.mocked(getFileStatusesForUser).mockResolvedValue([])
})

function makeRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/files/status${query}`)
}

describe('GET /api/files/status', () => {
  it('returns 401 when there is no authenticated user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined as any)

    const res = await GET(makeRequest('?keys=u1%2Fchats%2Fc1%2Ffoo.txt'))
    const json = await res.json()

    expect(res.status).toBe(401)
    expect(json).toEqual({ error: 'Unauthorized' })
    expect(getFileStatusesForUser).not.toHaveBeenCalled()
  })

  it('decodes and forwards the requested objectKeys, scoped to the current user', async () => {
    vi.mocked(getFileStatusesForUser).mockResolvedValue([
      {
        objectKey: 'u1/chats/c1/foo.txt',
        status: 'ready',
        ingestStage: null,
        ingestError: null
      }
    ])

    const res = await GET(
      makeRequest('?keys=u1%2Fchats%2Fc1%2Ffoo.txt,u1%2Fchats%2Fc1%2Fbar.txt')
    )
    const json = await res.json()

    expect(getCurrentUserId).toHaveBeenCalled()
    expect(getFileStatusesForUser).toHaveBeenCalledWith('u1', [
      'u1/chats/c1/foo.txt',
      'u1/chats/c1/bar.txt'
    ])
    expect(json).toEqual({
      statuses: [
        {
          objectKey: 'u1/chats/c1/foo.txt',
          status: 'ready',
          ingestStage: null,
          ingestError: null
        }
      ]
    })
  })

  it('caps the number of keys forwarded to 20', async () => {
    const keys = Array.from({ length: 25 }, (_, i) => `k${i}`)

    await GET(makeRequest(`?keys=${keys.join(',')}`))

    expect(getFileStatusesForUser).toHaveBeenCalledWith('u1', keys.slice(0, 20))
  })

  it('drops empty segments and defaults to an empty key list when the param is missing', async () => {
    await GET(makeRequest('?keys=a,,b'))
    expect(getFileStatusesForUser).toHaveBeenCalledWith('u1', ['a', 'b'])

    vi.mocked(getFileStatusesForUser).mockClear()

    await GET(makeRequest(''))
    expect(getFileStatusesForUser).toHaveBeenCalledWith('u1', [])
  })
})
