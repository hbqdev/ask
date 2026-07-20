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
    execute.mockResolvedValueOnce([])
    expect(await claimNextIngestJob()).toBeNull()
  })

  it('claimNextIngestJob returns the claimed row', async () => {
    execute.mockResolvedValueOnce([
      {
        id: 'f1',
        filename: 'a.mp3',
        media_type: 'audio/mpeg',
        size: 123,
        object_key: 'u1/chats/c1/1-a.mp3'
      }
    ])
    expect(await claimNextIngestJob()).toEqual({
      id: 'f1',
      filename: 'a.mp3',
      mediaType: 'audio/mpeg',
      size: 123,
      objectKey: 'u1/chats/c1/1-a.mp3'
    })
  })

  // Compiles the SQL object actually handed to db.execute (2nd call = the
  // UPDATE) via PgDialect, so we assert on the real payload — not just the
  // returned status — per the brief: "both branches assert the UPDATE
  // payload." Without this, a regression that hardcodes status, drops
  // ingest_error, or forgets to clear ingest_stage/claimed_at would still
  // pass.
  function assertUpdatePayload(
    expectedStatus: 'pending' | 'failed',
    expectedError: string,
    expectedId: string
  ) {
    const updateCall = execute.mock.calls[1][0]
    const { sql: compiled, params } = new PgDialect().sqlToQuery(updateCall)
    expect(params).toEqual([expectedStatus, expectedError, expectedId])
    expect(compiled).toMatch(/ingest_stage\s*=\s*NULL/i)
    expect(compiled).toMatch(/claimed_at\s*=\s*NULL/i)
  }

  it('completeIngestFailure requeues retryable failures with attempts left', async () => {
    execute.mockResolvedValueOnce([{ attempts: 1 }]) // current row
    execute.mockResolvedValueOnce([]) // update
    expect(await completeIngestFailure('f1', 'ollama down', true)).toBe(
      'pending'
    )
    assertUpdatePayload('pending', 'ollama down', 'f1')
  })

  it('completeIngestFailure fails permanently when attempts are exhausted', async () => {
    execute.mockResolvedValueOnce([{ attempts: 3 }])
    execute.mockResolvedValueOnce([])
    expect(await completeIngestFailure('f1', 'ollama down', true)).toBe(
      'failed'
    )
    assertUpdatePayload('failed', 'ollama down', 'f1')
  })

  it('completeIngestFailure fails immediately on non-retryable errors', async () => {
    execute.mockResolvedValueOnce([{ attempts: 0 }])
    execute.mockResolvedValueOnce([])
    expect(await completeIngestFailure('f1', 'corrupt file', false)).toBe(
      'failed'
    )
    assertUpdatePayload('failed', 'corrupt file', 'f1')
  })

  it('getFileStatusesForUser filters by userId AND inArray(objectKey)', async () => {
    const where = vi.fn().mockResolvedValue([
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
