import { NextRequest } from 'next/server'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'

// Auto-mocked; each test configures the resolved values it needs.
vi.mock('@/lib/db')
vi.mock('@/lib/db/file-actions')
vi.mock('@/lib/embeddings/upload-rag')

import { db } from '@/lib/db'
import {
  claimNextIngestJob,
  completeIngestFailure,
  markFileReady,
  updateIngestProgress
} from '@/lib/db/file-actions'
import { storeExtractedChunks } from '@/lib/embeddings/upload-rag'

// The file/[id] and complete routes read process.env.UPLOADS_DIR into a
// module-level const, so the env var must be set *before* the module is
// first evaluated — dynamic import inside beforeAll, same trick as
// app/api/upload/__tests__/route.test.ts.
let uploadsDir: string
let claimPOST: typeof import('../claim/route').POST
let fileGET: typeof import('../file/[id]/route').GET
let progressPOST: typeof import('../progress/route').POST
let completePOST: typeof import('../complete/route').POST

beforeAll(async () => {
  uploadsDir = await mkdtemp(path.join(tmpdir(), 'ask-ingest-test-'))
  process.env.UPLOADS_DIR = uploadsDir
  vi.resetModules()
  ;({ POST: claimPOST } = await import('../claim/route'))
  ;({ GET: fileGET } = await import('../file/[id]/route'))
  ;({ POST: progressPOST } = await import('../progress/route'))
  ;({ POST: completePOST } = await import('../complete/route'))
})

afterAll(async () => {
  await rm(uploadsDir, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const AUTH = { authorization: 'Bearer t' }

function mockDbSelect(rows: unknown[]) {
  const mockLimit = vi.fn().mockResolvedValue(rows)
  const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit })
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere })
  vi.mocked(db).select = vi.fn().mockReturnValue({ from: mockFrom })
}

function getReq(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { method: 'GET', headers } as any)
}

function postReq(
  url: string,
  headers: Record<string, string> = {},
  body?: unknown
) {
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    duplex: body !== undefined ? 'half' : undefined
  } as any)
}

function fileParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

// For sending a body that isn't valid JSON at all — postReq always
// JSON.stringifies, which can't produce malformed JSON.
function rawPostReq(
  url: string,
  headers: Record<string, string>,
  rawBody: string
) {
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: rawBody,
    duplex: 'half'
  } as any)
}

describe('ingest auth: token unset', () => {
  // Empty string is falsy, same as an unset env var, for the `if (!token)`
  // check in checkIngestAuth — vi.stubEnv can't unset a var to `undefined`.
  beforeEach(() => vi.stubEnv('INGEST_API_TOKEN', ''))

  it('claim → 503 before claiming a job', async () => {
    const res = await claimPOST(postReq('http://x/api/ingest/claim', AUTH))
    expect(res.status).toBe(503)
    expect(claimNextIngestJob).not.toHaveBeenCalled()
  })

  it('file → 503 before any db lookup', async () => {
    const res = await fileGET(
      getReq('http://x/api/ingest/file/f1', AUTH),
      fileParams('f1')
    )
    expect(res.status).toBe(503)
    expect(db.select).not.toHaveBeenCalled()
  })

  it('progress → 503 before updating progress', async () => {
    const res = await progressPOST(
      postReq('http://x/api/ingest/progress', AUTH, {
        fileId: 'f1',
        stage: 's'
      })
    )
    expect(res.status).toBe(503)
    expect(updateIngestProgress).not.toHaveBeenCalled()
  })

  it('complete → 503 before any db lookup', async () => {
    const res = await completePOST(
      postReq('http://x/api/ingest/complete', AUTH, {
        fileId: 'f1',
        chunks: ['a']
      })
    )
    expect(res.status).toBe(503)
    expect(db.select).not.toHaveBeenCalled()
  })
})

describe('ingest auth: wrong token', () => {
  beforeEach(() => vi.stubEnv('INGEST_API_TOKEN', 't'))

  const WRONG = { authorization: 'Bearer wrong' }

  it('claim → 401', async () => {
    const res = await claimPOST(postReq('http://x/api/ingest/claim', WRONG))
    expect(res.status).toBe(401)
    expect(claimNextIngestJob).not.toHaveBeenCalled()
  })

  it('file → 401', async () => {
    const res = await fileGET(
      getReq('http://x/api/ingest/file/f1', WRONG),
      fileParams('f1')
    )
    expect(res.status).toBe(401)
    expect(db.select).not.toHaveBeenCalled()
  })

  it('progress → 401', async () => {
    const res = await progressPOST(
      postReq('http://x/api/ingest/progress', WRONG, {
        fileId: 'f1',
        stage: 's'
      })
    )
    expect(res.status).toBe(401)
    expect(updateIngestProgress).not.toHaveBeenCalled()
  })

  it('complete → 401', async () => {
    const res = await completePOST(
      postReq('http://x/api/ingest/complete', WRONG, {
        fileId: 'f1',
        chunks: ['a']
      })
    )
    expect(res.status).toBe(401)
    expect(db.select).not.toHaveBeenCalled()
  })

  // WRONG ('Bearer wrong') differs in length from the expected 'Bearer t',
  // so the tests above only ever exercise checkIngestAuth's length-guard
  // branch and never reach crypto.timingSafeEqual. A same-length wrong
  // value is needed to actually exercise the constant-time byte comparison.
  it('claim → 401 for a same-length wrong token (exercises the timingSafeEqual byte compare)', async () => {
    const res = await claimPOST(
      postReq('http://x/api/ingest/claim', { authorization: 'Bearer x' })
    )
    expect(res.status).toBe(401)
    expect(claimNextIngestJob).not.toHaveBeenCalled()
  })
})

describe('POST /api/ingest/claim', () => {
  beforeEach(() => vi.stubEnv('INGEST_API_TOKEN', 't'))

  it('returns 204 when the queue is empty', async () => {
    vi.mocked(claimNextIngestJob).mockResolvedValue(null)
    const res = await claimPOST(postReq('http://x/api/ingest/claim', AUTH))
    expect(res.status).toBe(204)
  })

  it('returns the job JSON shape when a job is claimed', async () => {
    vi.mocked(claimNextIngestJob).mockResolvedValue({
      id: 'f1',
      filename: 'a.pdf',
      mediaType: 'application/pdf',
      size: 123,
      objectKey: 'u1/a.pdf'
    })
    const res = await claimPOST(postReq('http://x/api/ingest/claim', AUTH))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      fileId: 'f1',
      filename: 'a.pdf',
      mediaType: 'application/pdf',
      size: 123
    })
  })
})

describe('GET /api/ingest/file/[id]', () => {
  beforeEach(() => vi.stubEnv('INGEST_API_TOKEN', 't'))

  it('returns 404 when no row (or no objectKey) matches', async () => {
    mockDbSelect([])
    const res = await fileGET(
      getReq('http://x/api/ingest/file/f1', AUTH),
      fileParams('f1')
    )
    expect(res.status).toBe(404)
  })

  it('streams the file bytes with the row content-type and length', async () => {
    await mkdir(path.join(uploadsDir, 'sub'), { recursive: true })
    await writeFile(path.join(uploadsDir, 'sub', 'doc.pdf'), 'hello-bytes')
    mockDbSelect([
      { id: 'f1', objectKey: 'sub/doc.pdf', mediaType: 'application/pdf' }
    ])

    const res = await fileGET(
      getReq('http://x/api/ingest/file/f1', AUTH),
      fileParams('f1')
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-length')).toBe(
      String(Buffer.byteLength('hello-bytes'))
    )
    await expect(res.text()).resolves.toBe('hello-bytes')
  })

  it('rejects an objectKey that resolves outside UPLOADS_DIR with 400', async () => {
    mockDbSelect([
      {
        id: 'f1',
        objectKey: '../../../../../../../../etc/passwd',
        mediaType: 'text/plain'
      }
    ])
    const res = await fileGET(
      getReq('http://x/api/ingest/file/f1', AUTH),
      fileParams('f1')
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/ingest/progress', () => {
  beforeEach(() => vi.stubEnv('INGEST_API_TOKEN', 't'))

  it('returns 400 on a bad body', async () => {
    const res = await progressPOST(
      postReq('http://x/api/ingest/progress', AUTH, {
        fileId: 123,
        stage: 's'
      })
    )
    expect(res.status).toBe(400)
    expect(updateIngestProgress).not.toHaveBeenCalled()
  })

  it('calls updateIngestProgress and returns its result', async () => {
    vi.mocked(updateIngestProgress).mockResolvedValue(true)
    const res = await progressPOST(
      postReq('http://x/api/ingest/progress', AUTH, {
        fileId: 'f1',
        stage: 'extracting'
      })
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(updateIngestProgress).toHaveBeenCalledWith('f1', 'extracting')
  })

  it('returns 400 on a malformed JSON body instead of throwing', async () => {
    const res = await progressPOST(
      rawPostReq(
        'http://x/api/ingest/progress',
        { ...AUTH, 'content-type': 'application/json' },
        '{not valid json'
      )
    )
    expect(res.status).toBe(400)
    expect(updateIngestProgress).not.toHaveBeenCalled()
  })

  it('truncates an overlong stage to 64 chars before persisting', async () => {
    vi.mocked(updateIngestProgress).mockResolvedValue(true)
    const longStage = 'x'.repeat(100)
    const res = await progressPOST(
      postReq('http://x/api/ingest/progress', AUTH, {
        fileId: 'f1',
        stage: longStage
      })
    )
    expect(res.status).toBe(200)
    expect(updateIngestProgress).toHaveBeenCalledWith('f1', 'x'.repeat(64))
  })
})

describe('POST /api/ingest/complete', () => {
  beforeEach(() => vi.stubEnv('INGEST_API_TOKEN', 't'))

  it('returns 404 for an unknown file', async () => {
    mockDbSelect([])
    const res = await completePOST(
      postReq('http://x/api/ingest/complete', AUTH, {
        fileId: 'nope',
        chunks: ['a']
      })
    )
    expect(res.status).toBe(404)
  })

  it('routes error+retryable through completeIngestFailure and returns its status', async () => {
    mockDbSelect([{ id: 'f1', objectKey: 'u1/f1.pdf', filename: 'a.pdf' }])
    vi.mocked(completeIngestFailure).mockResolvedValue('pending')

    const res = await completePOST(
      postReq('http://x/api/ingest/complete', AUTH, {
        fileId: 'f1',
        error: 'timeout',
        retryable: true
      })
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ status: 'pending' })
    expect(completeIngestFailure).toHaveBeenCalledWith('f1', 'timeout', true)
    expect(storeExtractedChunks).not.toHaveBeenCalled()
  })

  it('rejects more than 2000 chunks with 400', async () => {
    mockDbSelect([{ id: 'f1', objectKey: 'u1/f1.pdf', filename: 'a.pdf' }])
    const chunks = Array.from({ length: 2001 }, (_, i) => `chunk-${i}`)

    const res = await completePOST(
      postReq('http://x/api/ingest/complete', AUTH, { fileId: 'f1', chunks })
    )

    expect(res.status).toBe(400)
    expect(storeExtractedChunks).not.toHaveBeenCalled()
  })

  it('accepts exactly 2000 chunks (boundary — not >2000)', async () => {
    mockDbSelect([{ id: 'f1', objectKey: 'u1/f1.pdf', filename: 'a.pdf' }])
    vi.mocked(storeExtractedChunks).mockResolvedValue(undefined)
    const chunks = Array.from({ length: 2000 }, (_, i) => `chunk-${i}`)

    const res = await completePOST(
      postReq('http://x/api/ingest/complete', AUTH, { fileId: 'f1', chunks })
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ status: 'ready' })
    expect(storeExtractedChunks).toHaveBeenCalledWith(
      path.join(uploadsDir, 'u1/f1.pdf'),
      'a.pdf',
      chunks
    )
  })

  it('rejects non-string chunk entries with 400', async () => {
    mockDbSelect([{ id: 'f1', objectKey: 'u1/f1.pdf', filename: 'a.pdf' }])

    const res = await completePOST(
      postReq('http://x/api/ingest/complete', AUTH, {
        fileId: 'f1',
        chunks: [1, 2, 3]
      })
    )

    expect(res.status).toBe(400)
    expect(storeExtractedChunks).not.toHaveBeenCalled()
  })

  it('returns 400 on a malformed JSON body instead of throwing', async () => {
    const res = await completePOST(
      rawPostReq(
        'http://x/api/ingest/complete',
        { ...AUTH, 'content-type': 'application/json' },
        '{not valid json'
      )
    )
    expect(res.status).toBe(400)
    expect(db.select).not.toHaveBeenCalled()
  })

  it('happy path stores chunks at the absolute path and marks the file ready', async () => {
    mockDbSelect([{ id: 'f1', objectKey: 'u1/f1.pdf', filename: 'a.pdf' }])
    vi.mocked(storeExtractedChunks).mockResolvedValue(undefined)

    const res = await completePOST(
      postReq('http://x/api/ingest/complete', AUTH, {
        fileId: 'f1',
        chunks: ['one', 'two']
      })
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ status: 'ready' })
    expect(storeExtractedChunks).toHaveBeenCalledWith(
      path.join(uploadsDir, 'u1/f1.pdf'),
      'a.pdf',
      ['one', 'two']
    )
    expect(markFileReady).toHaveBeenCalledWith('f1')
  })

  it('returns 503 and does not mark the file ready when storeExtractedChunks throws', async () => {
    mockDbSelect([{ id: 'f1', objectKey: 'u1/f1.pdf', filename: 'a.pdf' }])
    vi.mocked(storeExtractedChunks).mockRejectedValue(
      new Error('embedder down')
    )

    const res = await completePOST(
      postReq('http://x/api/ingest/complete', AUTH, {
        fileId: 'f1',
        chunks: ['one']
      })
    )

    expect(res.status).toBe(503)
    expect(markFileReady).not.toHaveBeenCalled()
  })
})
