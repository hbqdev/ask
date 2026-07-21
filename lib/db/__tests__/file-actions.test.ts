import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock factories are hoisted above top-level const declarations, so the
// outer `execute`/`select` must be created via vi.hoisted (same pattern as
// lib/storage/__tests__/r2-client.test.ts) or the mock throws
// "Cannot access 'execute' before initialization".
const { execute, select } = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn()
}))
vi.mock('@/lib/db', () => ({ db: { execute, select } }))

const { stat, unlink } = vi.hoisted(() => ({ stat: vi.fn(), unlink: vi.fn() }))
// Vitest 4's ESM interop for a mocked Node builtin also reads a `default`, so
// expose the same shape both ways (file-actions imports `{ promises as fs }`).
vi.mock('node:fs', () => ({
  default: { promises: { stat, unlink } },
  promises: { stat, unlink }
}))
vi.mock('@/lib/embeddings/upload-rag', () => ({
  chunksFilePath: (p: string) => p + '.chunks.json'
}))

import {
  claimNextIngestJob,
  completeIngestFailure,
  expireIdleUploads,
  getFileStatusesForUser
} from '../file-actions'

describe('file-actions ingest state', () => {
  beforeEach(() => vi.clearAllMocks())

  it('claimNextIngestJob returns null on an empty queue', async () => {
    execute.mockResolvedValueOnce([]) // finalize-stuck sweep
    execute.mockResolvedValueOnce([]) // claim UPDATE
    expect(await claimNextIngestJob()).toBeNull()
  })

  it('claimNextIngestJob returns the claimed row', async () => {
    execute.mockResolvedValueOnce([]) // finalize-stuck sweep
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

  // Spec: a job that reaches attempts=MAX via silent worker death (never
  // reports) is left status='processing', is excluded from the attempts<MAX
  // requeue selector, and would otherwise be stuck forever. Every claim poll
  // must first finalize such rows to 'failed' with a reason so they leave the
  // queue within one stale window.
  it('finalizes stuck processing rows (attempts>=MAX, stale claim) to failed before claiming', async () => {
    execute.mockResolvedValueOnce([]) // finalize-stuck sweep
    execute.mockResolvedValueOnce([]) // claim UPDATE (empty queue)

    await claimNextIngestJob()

    expect(execute).toHaveBeenCalledTimes(2)
    const sweepCall = execute.mock.calls[0][0]
    const { sql: compiled, params } = new PgDialect().sqlToQuery(sweepCall)
    expect(compiled).toMatch(/status\s*=\s*'failed'/i)
    expect(compiled).toMatch(/ingest_error\s*=\s*'retries exhausted'/i)
    expect(compiled).toMatch(/ingest_stage\s*=\s*NULL/i)
    expect(compiled).toMatch(/claimed_at\s*=\s*NULL/i)
    // Only sweeps rows that are still 'processing', at/over the attempt cap,
    // and stale — never a healthy in-flight job.
    expect(compiled).toMatch(/status\s*=\s*'processing'/i)
    expect(compiled).toMatch(/attempts\s*>=\s*\$/)
    expect(compiled).toMatch(/claimed_at\s*<\s*now\(\)/i)
    expect(params).toContain(3) // MAX_ATTEMPTS
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

describe('expireIdleUploads', () => {
  const OLD = process.env.UPLOAD_TTL_DAYS
  const OLD_DIR = process.env.UPLOADS_DIR
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.UPLOADS_DIR = '/app/uploads'
    process.env.UPLOAD_TTL_DAYS = '14'
  })
  afterEach(() => {
    process.env.UPLOAD_TTL_DAYS = OLD
    process.env.UPLOADS_DIR = OLD_DIR
  })

  it('is a no-op when UPLOAD_TTL_DAYS is 0', async () => {
    process.env.UPLOAD_TTL_DAYS = '0'
    expect(await expireIdleUploads()).toEqual({
      expired: 0,
      bytesFreed: 0,
      scanned: 0
    })
    expect(execute).not.toHaveBeenCalled()
  })

  // Safety default: the sweep is DESTRUCTIVE, so an unset var must disable it
  // (operators opt in with a positive value; prod sets 14 explicitly). Guards
  // the `?? 0` default in uploadTtlDays — a `?? 14` regression would run the
  // sweep here and call execute.
  it('is a no-op when UPLOAD_TTL_DAYS is unset', async () => {
    delete process.env.UPLOAD_TTL_DAYS
    expect(await expireIdleUploads()).toEqual({
      expired: 0,
      bytesFreed: 0,
      scanned: 0
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('unlinks bytes + sidecar and tombstones each returned row', async () => {
    execute.mockResolvedValueOnce([
      { id: 'f1', object_key: 'u1/chats/c1/1-a.png', size: 100 }
    ]) // the SELECT
    execute.mockResolvedValueOnce([]) // the UPDATE tombstone
    stat.mockResolvedValueOnce({ size: 100 }) // bytes
    stat.mockResolvedValueOnce({ size: 20 }) // sidecar
    unlink.mockResolvedValue(undefined)

    const summary = await expireIdleUploads()

    expect(unlink).toHaveBeenCalledWith('/app/uploads/u1/chats/c1/1-a.png')
    expect(unlink).toHaveBeenCalledWith(
      '/app/uploads/u1/chats/c1/1-a.png.chunks.json'
    )
    // UPDATE ... status='expired' for the row. Compile the SQL object the way
    // the ingest-state tests above do (a drizzle SQL object stringifies to
    // "[object Object]", so assert on the rendered query instead).
    const updateSql = execute.mock.calls[1][0]
    const { sql: compiledUpdate } = new PgDialect().sqlToQuery(updateSql)
    expect(compiledUpdate).toMatch(/status/i)
    expect(summary).toEqual({ expired: 1, bytesFreed: 120, scanned: 1 })
  })

  it('skips object keys that would escape the uploads root', async () => {
    execute.mockResolvedValueOnce([
      { id: 'evil', object_key: '../../etc/passwd', size: 0 }
    ])
    await expireIdleUploads()
    expect(unlink).not.toHaveBeenCalled()
    // no tombstone UPDATE for a skipped row
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('ignores a missing file (already gone) but still tombstones', async () => {
    execute.mockResolvedValueOnce([
      { id: 'f2', object_key: 'u1/chats/c1/2-b.pdf', size: 0 }
    ])
    execute.mockResolvedValueOnce([]) // UPDATE
    stat.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }))
    const summary = await expireIdleUploads()
    expect(summary).toEqual({ expired: 1, bytesFreed: 0, scanned: 1 })
  })
})
