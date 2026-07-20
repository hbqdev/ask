import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock factories are hoisted above top-level const declarations, so the
// outer `execute`/`select` must be created via vi.hoisted (same pattern as
// lib/storage/__tests__/r2-client.test.ts) or the mock throws
// "Cannot access 'execute' before initialization".
const { execute, select } = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn()
}))
vi.mock('@/lib/db', () => ({ db: { execute, select } }))

import {
  claimNextIngestJob,
  completeIngestFailure,
  getFileStatusesForUser
} from '../file-actions'

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

  it('getFileStatusesForUser filters by userId AND inArray(objectKey)', async () => {
    const where = vi
      .fn()
      .mockResolvedValue([
        {
          objectKey: 'k1',
          status: 'ready',
          ingestStage: null,
          ingestError: null
        }
      ])
    const from = vi.fn().mockReturnValue({ where })
    select.mockReturnValue({ from })

    const result = await getFileStatusesForUser('u1', ['k1', 'k2'])

    expect(result).toEqual([
      { objectKey: 'k1', status: 'ready', ingestStage: null, ingestError: null }
    ])
    // Assert the compiled WHERE clause actually filters by userId AND
    // inArray(objectKey) — not just that some query ran. Mirrors
    // recall-actions-sql.test.ts, which exists precisely because a mocked
    // call can look right while the generated SQL is broken (see
    // drizzle ANY(array) pitfall).
    const whereClause = where.mock.calls[0][0]
    const { sql: compiled } = new PgDialect().sqlToQuery(whereClause.getSQL())
    expect(compiled).toMatch(/"user_id" = \$/)
    expect(compiled.toLowerCase()).toMatch(/"object_key" in \(\$/)
  })
})
