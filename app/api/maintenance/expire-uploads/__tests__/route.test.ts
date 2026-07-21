import { NextRequest } from 'next/server'

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'

// Auto-mocked; each test configures the resolved values it needs. The route's
// auth gate (checkIngestAuth) is intentionally left real so the constant-time
// bearer comparison is exercised end-to-end against process.env.
vi.mock('@/lib/db/file-actions')

import { expireIdleUploads } from '@/lib/db/file-actions'

const SUMMARY = {
  expired: 3,
  bytesFreed: 4096,
  scanned: 10,
  orphansRemoved: 2
}

let POST: typeof import('../route').POST

beforeAll(async () => {
  ;({ POST } = await import('../route'))
})

let savedToken: string | undefined

beforeEach(() => {
  savedToken = process.env.INGEST_API_TOKEN
  vi.clearAllMocks()
  vi.mocked(expireIdleUploads).mockResolvedValue(SUMMARY)
})

afterEach(() => {
  if (savedToken === undefined) delete process.env.INGEST_API_TOKEN
  else process.env.INGEST_API_TOKEN = savedToken
})

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(
    'http://localhost:3000/api/maintenance/expire-uploads',
    {
      method: 'POST',
      headers
    }
  )
}

describe('POST /api/maintenance/expire-uploads', () => {
  it('returns 503 and does not sweep when INGEST_API_TOKEN is unset', async () => {
    delete process.env.INGEST_API_TOKEN

    const res = await POST(makeRequest({ authorization: 'Bearer whatever' }))

    expect(res.status).toBe(503)
    expect(expireIdleUploads).not.toHaveBeenCalled()
  })

  it('returns 401 for a wrong bearer token', async () => {
    process.env.INGEST_API_TOKEN = 'right-token'

    const res = await POST(makeRequest({ authorization: 'Bearer wrong-token' }))

    expect(res.status).toBe(401)
    expect(expireIdleUploads).not.toHaveBeenCalled()
  })

  it('returns 200 with { summary } for the correct bearer token', async () => {
    process.env.INGEST_API_TOKEN = 'right-token'

    const res = await POST(makeRequest({ authorization: 'Bearer right-token' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ summary: SUMMARY })
    expect(expireIdleUploads).toHaveBeenCalledTimes(1)
  })
})
