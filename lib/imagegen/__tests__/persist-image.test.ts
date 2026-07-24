import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
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

// Only createFileRecord is consumed; isolate from the real DB module graph.
vi.mock('@/lib/db/file-actions', () => ({
  createFileRecord: vi.fn()
}))

import { createFileRecord } from '@/lib/db/file-actions'

import { persistGeneratedImage } from '../persist-image'

// Real temp dir mirrors app/api/upload/__tests__/route.ts: exercising the
// actual mkdir/writeFile/unlink is stronger evidence than asserting on mocked
// fs calls (and Node's node:fs builtin doesn't mock reliably anyway).
let uploadsDir: string

function mockResponse(opts: {
  ok?: boolean
  status?: number
  contentType?: string | null
  bytes?: Uint8Array
}) {
  const {
    ok = true,
    status = 200,
    contentType = 'image/png',
    bytes = new Uint8Array([1, 2, 3, 4])
  } = opts
  return {
    ok,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? contentType : null
    },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
}

const ARGS = {
  sourceUrl: 'https://replicate.delivery/x/out.png',
  userId: 'u1',
  chatId: 'c1',
  modelPath: 'black-forest-labs/flux-1.1-pro'
}

beforeAll(async () => {
  uploadsDir = await mkdtemp(path.join(tmpdir(), 'ask-imagegen-test-'))
})

afterAll(async () => {
  await rm(uploadsDir, { recursive: true, force: true })
})

describe('persistGeneratedImage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('UPLOADS_DIR', uploadsDir)
    vi.stubGlobal('fetch', vi.fn())
    vi.mocked(createFileRecord).mockResolvedValue({ id: 'gen-1' })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('writes under a TTL-exempt generated/ layout and returns the public URL', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({ contentType: 'image/png' }) as any
    )

    const res = await persistGeneratedImage(ARGS)

    expect('publicUrl' in res).toBe(true)
    if (!('publicUrl' in res)) return

    // objectKey shape: <userId>/generated/<chatId>/<ts>-<8char>.<ext>
    expect(res.objectKey).toMatch(/^u1\/generated\/c1\/\d+-[0-9a-f]{8}\.png$/)
    // The TTL-sweep exclusion (Task 5) keys on the SECOND path segment.
    expect(res.objectKey.split('/')[1]).toBe('generated')
    expect(res.publicUrl).toBe(`/uploads/${res.objectKey}`)

    // The bytes actually landed under UPLOADS_DIR at the objectKey path.
    const onDisk = await readFile(path.join(uploadsDir, res.objectKey))
    expect(Array.from(onDisk)).toEqual([1, 2, 3, 4])
  })

  it('persists a files-table row with status ready, mediaType, filename, and byte size', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({ contentType: 'image/png' }) as any
    )

    const res = await persistGeneratedImage(ARGS)
    if (!('publicUrl' in res)) throw new Error('expected success')

    expect(createFileRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        filename: 'generated-flux-1.1-pro.png',
        url: res.publicUrl,
        objectKey: res.objectKey,
        mediaType: 'image/png',
        size: 4,
        status: 'ready'
      })
    )
  })

  it('falls back to a "none" chat segment when chatId is absent', async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse({}) as any)

    const res = await persistGeneratedImage({
      sourceUrl: ARGS.sourceUrl,
      userId: 'u1',
      modelPath: 'google/nano-banana'
    })
    if (!('publicUrl' in res)) throw new Error('expected success')

    expect(res.objectKey).toMatch(/^u1\/generated\/none\/\d+-[0-9a-f]{8}\.png$/)
  })

  it('sanitizes a path-traversal chatId so it cannot escape UPLOADS_DIR or split the layout', async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse({}) as any)

    const res = await persistGeneratedImage({
      sourceUrl: ARGS.sourceUrl,
      userId: 'u1',
      chatId: '../../../etc',
      modelPath: 'google/nano-banana'
    })
    if (!('publicUrl' in res)) throw new Error('expected success')

    const segments = res.objectKey.split('/')
    // Layout holds: second segment stays TTL-exempt `generated`, and the
    // traversal collapses into a single slash-free third segment. The guard
    // (like the upload route's) also strips dots, so every `.` and `/` in
    // `../../../etc` becomes `_`.
    expect(segments[1]).toBe('generated')
    expect(segments[2]).toBe('_________etc')
    // No extra slashes beyond the four-segment layout's own.
    expect(segments).toHaveLength(4)

    // The file landed INSIDE the temp uploads dir, not above it.
    const absPath = path.join(uploadsDir, res.objectKey)
    expect(absPath.startsWith(uploadsDir + path.sep)).toBe(true)
    const onDisk = await readFile(absPath)
    expect(Array.from(onDisk)).toEqual([1, 2, 3, 4])
  })

  it.each([
    ['image/webp', 'webp'],
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/svg+xml', 'svg'],
    ['application/octet-stream', 'png'],
    [null, 'png']
  ])('maps content-type %s to extension .%s', async (contentType, ext) => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({ contentType: contentType as string | null }) as any
    )

    const res = await persistGeneratedImage(ARGS)
    if (!('publicUrl' in res)) throw new Error('expected success')

    expect(res.objectKey.endsWith(`.${ext}`)).toBe(true)
    expect(vi.mocked(createFileRecord).mock.calls[0][0].filename).toBe(
      `generated-flux-1.1-pro.${ext}`
    )
  })

  it('returns an error and writes nothing on a non-OK fetch', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({ ok: false, status: 404 }) as any
    )

    const res = await persistGeneratedImage(ARGS)

    expect(res).toMatchObject({ error: expect.any(String) })
    expect(createFileRecord).not.toHaveBeenCalled()
  })

  it('returns an error (never throws) when the fetch itself rejects', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'))

    const res = await persistGeneratedImage(ARGS)

    expect(res).toMatchObject({ error: expect.any(String) })
    expect(createFileRecord).not.toHaveBeenCalled()
  })

  it('unlinks the written file and returns an error when the DB insert fails', async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse({}) as any)
    vi.mocked(createFileRecord).mockRejectedValue(new Error('db down'))

    const res = await persistGeneratedImage(ARGS)

    expect(res).toMatchObject({ error: expect.any(String) })
    // The objectKey it attempted is recoverable from the insert call; confirm
    // the byte file it wrote no longer exists on disk.
    const attempted = vi.mocked(createFileRecord).mock.calls[0][0].objectKey
    await expect(stat(path.join(uploadsDir, attempted))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
