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

const { stat, unlink, readdir } = vi.hoisted(() => ({
  stat: vi.fn(),
  unlink: vi.fn(),
  readdir: vi.fn()
}))
// Vitest 4's ESM interop for a mocked Node builtin also reads a `default`, so
// expose the same shape both ways (file-actions imports `{ promises as fs }`).
vi.mock('node:fs', () => ({
  default: { promises: { stat, unlink, readdir } },
  promises: { stat, unlink, readdir }
}))
vi.mock('@/lib/embeddings/upload-rag', () => ({
  chunksFilePath: (p: string) => p + '.chunks.json'
}))

import {
  claimNextIngestJob,
  completeIngestFailure,
  expireIdleUploads,
  gcOrphanUploads,
  getFileStatusesForUser
} from '../file-actions'

// Minimal fs.Dirent stand-in for the withFileTypes:true walk gcOrphanUploads
// does. Only the three members the walker touches are implemented.
function dirent(name: string, kind: 'file' | 'dir' = 'file') {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file'
  }
}
const DAY_MS = 24 * 60 * 60 * 1000

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
      scanned: 0,
      orphansRemoved: 0
    })
    expect(execute).not.toHaveBeenCalled()
    // The GC pass must ALSO be gated by the disable — no disk scan when off.
    expect(readdir).not.toHaveBeenCalled()
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
      scanned: 0,
      orphansRemoved: 0
    })
    expect(execute).not.toHaveBeenCalled()
    expect(readdir).not.toHaveBeenCalled()
  })

  it('unlinks bytes + sidecar and tombstones each returned row', async () => {
    execute.mockResolvedValueOnce([
      { id: 'f1', object_key: 'u1/chats/c1/1-a.png', size: 100 }
    ]) // the SELECT
    execute.mockResolvedValueOnce([]) // the UPDATE tombstone
    execute.mockResolvedValueOnce([]) // the GC live-keys SELECT (no rows)
    readdir.mockResolvedValueOnce([]) // GC: empty uploads dir → no orphans
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
    expect(summary).toEqual({
      expired: 1,
      bytesFreed: 120,
      scanned: 1,
      orphansRemoved: 0
    })
  })

  // Generated images (key `<userId>/generated/<chatId>/<file>`) are chat
  // content, not user uploads — the idle sweep must never reap them or old
  // chats silently lose their images. The filtering happens in Postgres via
  // split_part, and db.execute is mocked here, so we prove BOTH directions the
  // way this file proves every other query shape (PgDialect on the compiled
  // SQL): the SELECT's WHERE excludes a `/generated/` second segment, while a
  // `/chats/` upload still flows all the way through to unlink + tombstone.
  it('excludes generated images from the sweep but still reaps a chats upload', async () => {
    execute.mockResolvedValueOnce([
      // What Postgres returns AFTER the split_part filter: the generated row is
      // gone, only the real chats upload remains selected for expiry.
      { id: 'f-pdf', object_key: 'u1/chats/c1/123-y.pdf', size: 50 }
    ]) // the SELECT
    execute.mockResolvedValueOnce([]) // the UPDATE tombstone
    execute.mockResolvedValueOnce([]) // the GC live-keys SELECT
    readdir.mockResolvedValueOnce([]) // GC: empty uploads dir
    stat.mockResolvedValueOnce({ size: 50 }) // bytes
    stat.mockResolvedValueOnce({ size: 10 }) // sidecar
    unlink.mockResolvedValue(undefined)

    const summary = await expireIdleUploads()

    // Exclusion direction: the compiled SELECT must carry the clause that keeps
    // any `<userId>/generated/...` key out of the result set.
    const selectSql = execute.mock.calls[0][0]
    const { sql: compiledSelect } = new PgDialect().sqlToQuery(selectSql)
    expect(compiledSelect).toMatch(
      /split_part\(f\.object_key,\s*'\/',\s*2\)\s*<>\s*'generated'/i
    )

    // Inclusion direction: a `/chats/` upload on the same idle chat IS swept.
    expect(unlink).toHaveBeenCalledWith('/app/uploads/u1/chats/c1/123-y.pdf')
    expect(summary.expired).toBe(1)
  })

  it('skips object keys that would escape the uploads root', async () => {
    execute.mockResolvedValueOnce([
      { id: 'evil', object_key: '../../etc/passwd', size: 0 }
    ])
    execute.mockResolvedValueOnce([]) // the GC live-keys SELECT
    readdir.mockResolvedValueOnce([]) // GC: empty uploads dir
    await expireIdleUploads()
    expect(unlink).not.toHaveBeenCalled()
    // Two SELECTs (main sweep + GC live-keys), but NO tombstone UPDATE for the
    // escaping row — the UPDATE would be a third execute call.
    expect(execute).toHaveBeenCalledTimes(2)
  })

  // Brief case (a): a row whose bytes are already gone (stat → ENOENT) is still
  // counted as expired (DB-side tombstone) with bytesFreed 0.
  it('ignores a missing file (already gone) but still tombstones', async () => {
    execute.mockResolvedValueOnce([
      { id: 'f2', object_key: 'u1/chats/c1/2-b.pdf', size: 0 }
    ])
    execute.mockResolvedValueOnce([]) // UPDATE
    execute.mockResolvedValueOnce([]) // GC live-keys SELECT
    readdir.mockResolvedValueOnce([]) // GC: empty uploads dir
    stat.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }))
    const summary = await expireIdleUploads()
    expect(summary).toEqual({
      expired: 1,
      bytesFreed: 0,
      scanned: 1,
      orphansRemoved: 0
    })
  })

  // Brief: gcOrphanUploads' count is folded into the summary's orphansRemoved.
  it('folds the GC orphan count into orphansRemoved', async () => {
    execute.mockResolvedValueOnce([]) // main sweep SELECT: no idle rows
    execute.mockResolvedValueOnce([]) // GC live-keys SELECT: nothing live
    readdir.mockResolvedValueOnce([dirent('1-orphan.png')])
    stat.mockResolvedValue({ mtimeMs: Date.now() - 30 * DAY_MS, size: 7 })
    unlink.mockResolvedValue(undefined)

    const summary = await expireIdleUploads()

    expect(summary).toEqual({
      expired: 0,
      bytesFreed: 0,
      scanned: 0,
      orphansRemoved: 1
    })
    expect(unlink).toHaveBeenCalledWith('/app/uploads/1-orphan.png')
  })
})

describe('gcOrphanUploads', () => {
  const OLD_DIR = process.env.UPLOADS_DIR
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.UPLOADS_DIR = '/app/uploads'
  })
  afterEach(() => {
    process.env.UPLOADS_DIR = OLD_DIR
  })

  // Defense-in-depth: this is the most destructive function in the codebase.
  // With days <= 0 (or NaN) the age cutoff collapses to "now", which would reap
  // every orphan regardless of age. The sole caller gates via expireIdleUploads'
  // days===0 early return, but the function must be safe on its own — a bad
  // `days` must do NOTHING: no live-keys query, no disk scan.
  it('is a no-op (no query, no scan) when days is 0 or negative', async () => {
    execute.mockResolvedValue([])
    readdir.mockResolvedValue([])

    expect(await gcOrphanUploads(0)).toBe(0)
    expect(await gcOrphanUploads(-5)).toBe(0)
    expect(await gcOrphanUploads(Number.NaN)).toBe(0)

    expect(execute).not.toHaveBeenCalled()
    expect(readdir).not.toHaveBeenCalled()
  })

  // Brief case (b): a stray on-disk file whose object_key matches no row and is
  // older than the TTL → unlinked, along with its .chunks.json sidecar.
  it('unlinks an orphan file (and its sidecar) older than the TTL', async () => {
    execute.mockResolvedValueOnce([{ object_key: 'u1/chats/live/keep.png' }])
    readdir.mockResolvedValueOnce([dirent('1-orphan.png')])
    stat.mockResolvedValue({ mtimeMs: Date.now() - 30 * DAY_MS, size: 42 })
    unlink.mockResolvedValue(undefined)

    const removed = await gcOrphanUploads(14)

    expect(removed).toBe(1)
    expect(unlink).toHaveBeenCalledWith('/app/uploads/1-orphan.png')
    expect(unlink).toHaveBeenCalledWith('/app/uploads/1-orphan.png.chunks.json')
  })

  // Brief case (c): a stray file that DOES match a live row is left untouched —
  // and, being a live match, is never even statted.
  it('leaves a file that matches a live row untouched', async () => {
    execute.mockResolvedValueOnce([{ object_key: '1-a.png' }])
    readdir.mockResolvedValueOnce([dirent('1-a.png')])

    const removed = await gcOrphanUploads(14)

    expect(removed).toBe(0)
    expect(unlink).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
  })

  // An orphan whose mtime is still within the TTL window (e.g. a just-uploaded
  // file whose row hasn't committed yet) must NOT be reaped.
  it('leaves an orphan whose mtime is newer than the TTL', async () => {
    execute.mockResolvedValueOnce([]) // nothing live
    readdir.mockResolvedValueOnce([dirent('fresh.png')])
    stat.mockResolvedValue({ mtimeMs: Date.now() - 1 * DAY_MS, size: 9 })

    const removed = await gcOrphanUploads(14)

    expect(removed).toBe(0)
    expect(unlink).not.toHaveBeenCalled()
  })

  // Recurses into subdirectories, derives object_key relative to UPLOADS_DIR,
  // and skips a bare .chunks.json entry (the sidecar is only removed alongside
  // its parent bytes — never treated as its own orphan).
  it('recurses into subdirs, derives object_key, and skips bare sidecars', async () => {
    execute.mockResolvedValueOnce([]) // nothing live
    readdir
      .mockResolvedValueOnce([dirent('u1', 'dir')]) // UPLOADS_DIR
      .mockResolvedValueOnce([dirent('chats', 'dir')]) // u1
      .mockResolvedValueOnce([dirent('c1', 'dir')]) // u1/chats
      .mockResolvedValueOnce([
        dirent('9-deep.pdf'),
        dirent('9-deep.pdf.chunks.json')
      ]) // u1/chats/c1
    stat.mockResolvedValue({ mtimeMs: Date.now() - 30 * DAY_MS, size: 5 })
    unlink.mockResolvedValue(undefined)

    const removed = await gcOrphanUploads(14)

    expect(removed).toBe(1) // only the pdf, not the sidecar entry
    expect(unlink).toHaveBeenCalledWith('/app/uploads/u1/chats/c1/9-deep.pdf')
    expect(unlink).toHaveBeenCalledWith(
      '/app/uploads/u1/chats/c1/9-deep.pdf.chunks.json'
    )
    // The bare sidecar entry was skipped in the walk — never processed as its
    // own file (which would try to unlink a doubled .chunks.json.chunks.json).
    expect(unlink).not.toHaveBeenCalledWith(
      '/app/uploads/u1/chats/c1/9-deep.pdf.chunks.json.chunks.json'
    )
  })

  // Caps deletions per run so one tick can't become an unbounded delete storm;
  // hitting the cap is logged, never silently truncated.
  it('caps deletions per run and warns when the cap is hit', async () => {
    execute.mockResolvedValueOnce([]) // nothing live
    const entries = Array.from({ length: 501 }, (_, i) =>
      dirent(`orphan-${i}.png`)
    )
    readdir.mockResolvedValueOnce(entries)
    stat.mockResolvedValue({ mtimeMs: Date.now() - 30 * DAY_MS, size: 1 })
    unlink.mockResolvedValue(undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const removed = await gcOrphanUploads(14)

    expect(removed).toBe(500)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
