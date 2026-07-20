import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock factories are hoisted above top-level const declarations, so the
// outer `execute` must be created via vi.hoisted (same pattern as
// lib/storage/__tests__/r2-client.test.ts) or the mock throws
// "Cannot access 'execute' before initialization".
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { execute } }))

import { claimNextIngestJob, completeIngestFailure } from '../file-actions'

describe('file-actions ingest state', () => {
  beforeEach(() => vi.clearAllMocks())

  it('claimNextIngestJob returns null on an empty queue', async () => {
    execute.mockResolvedValueOnce({ rows: [] })
    expect(await claimNextIngestJob()).toBeNull()
  })

  it('claimNextIngestJob returns the claimed row', async () => {
    execute.mockResolvedValueOnce({
      rows: [
        {
          id: 'f1',
          filename: 'a.mp3',
          media_type: 'audio/mpeg',
          size: 123,
          object_key: 'u1/chats/c1/1-a.mp3'
        }
      ]
    })
    expect(await claimNextIngestJob()).toEqual({
      id: 'f1',
      filename: 'a.mp3',
      mediaType: 'audio/mpeg',
      size: 123,
      objectKey: 'u1/chats/c1/1-a.mp3'
    })
  })

  it('completeIngestFailure requeues retryable failures with attempts left', async () => {
    execute.mockResolvedValueOnce({ rows: [{ attempts: 1 }] }) // current row
    execute.mockResolvedValueOnce({ rows: [] }) // update
    expect(await completeIngestFailure('f1', 'ollama down', true)).toBe(
      'pending'
    )
  })

  it('completeIngestFailure fails permanently when attempts are exhausted', async () => {
    execute.mockResolvedValueOnce({ rows: [{ attempts: 3 }] })
    execute.mockResolvedValueOnce({ rows: [] })
    expect(await completeIngestFailure('f1', 'ollama down', true)).toBe(
      'failed'
    )
  })

  it('completeIngestFailure fails immediately on non-retryable errors', async () => {
    execute.mockResolvedValueOnce({ rows: [{ attempts: 0 }] })
    execute.mockResolvedValueOnce({ rows: [] })
    expect(await completeIngestFailure('f1', 'corrupt file', false)).toBe(
      'failed'
    )
  })
})
