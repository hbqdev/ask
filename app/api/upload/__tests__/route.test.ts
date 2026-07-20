import { NextRequest } from 'next/server'

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'

// Auto-mocked; each test configures the resolved values it needs.
vi.mock('@/lib/auth/get-current-user')
vi.mock('@/lib/db/file-actions')
vi.mock('@/lib/embeddings/upload-rag')

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { createFileRecord, markFileReady } from '@/lib/db/file-actions'
import { isTextFamily, processFileForRAG } from '@/lib/embeddings/upload-rag'

// route.ts reads process.env.UPLOADS_DIR into a module-level const, so the
// env var must be set *before* the module is first evaluated — plain
// top-of-file assignment wouldn't beat the hoisted `import`, hence the
// dynamic import inside beforeAll.
let uploadsDir: string
let POST: typeof import('../route').POST

beforeAll(async () => {
  uploadsDir = await mkdtemp(path.join(tmpdir(), 'ask-upload-test-'))
  process.env.UPLOADS_DIR = uploadsDir
  vi.resetModules()
  ;({ POST } = await import('../route'))
})

afterAll(async () => {
  await rm(uploadsDir, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCurrentUserId).mockResolvedValue('u1')
  vi.mocked(createFileRecord).mockResolvedValue({ id: 'file-1' })
  vi.mocked(markFileReady).mockResolvedValue(undefined)
  vi.mocked(isTextFamily).mockImplementation(
    (mediaType: string, filename: string) =>
      mediaType.startsWith('text/') || filename.endsWith('.txt')
  )
  vi.mocked(processFileForRAG).mockResolvedValue(true)
})

function makeRequest(
  body: string,
  headers: Record<string, string>
): NextRequest {
  return new NextRequest('http://localhost:3000/api/upload', {
    method: 'POST',
    headers,
    body,
    duplex: 'half'
  } as any)
}

describe('POST /api/upload', () => {
  it('returns 401 when there is no authenticated user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined as any)

    const req = makeRequest('hello world', {
      'content-type': 'text/plain',
      'x-filename': encodeURIComponent('notes.txt'),
      'x-chat-id': 'c1'
    })

    const res = await POST(req)

    expect(res.status).toBe(401)
    expect(createFileRecord).not.toHaveBeenCalled()
  })

  it('rejects an unsupported file extension with 400', async () => {
    const req = makeRequest('PKfake zip bytes', {
      'content-type': 'application/zip',
      'x-filename': encodeURIComponent('archive.zip'),
      'x-chat-id': 'c1'
    })

    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toBe('Unsupported file type')
    expect(createFileRecord).not.toHaveBeenCalled()
  })

  it('rejects a body over the 2GB cap using the content-length header', async () => {
    const req = makeRequest('tiny body, huge declared size', {
      'content-type': 'text/plain',
      'x-filename': encodeURIComponent('notes.txt'),
      'x-chat-id': 'c1',
      'content-length': String(2 * 1024 * 1024 * 1024 + 1)
    })

    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toBe('File too large (max 2GB)')
    expect(createFileRecord).not.toHaveBeenCalled()
  })

  it('writes the file to disk, creates the file row, and returns id/objectKey/status on the happy path', async () => {
    const content = 'hello world'
    const req = makeRequest(content, {
      'content-type': 'text/plain',
      'x-filename': encodeURIComponent('notes.txt'),
      'x-chat-id': 'c1'
    })

    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({
      success: true,
      file: {
        id: 'file-1',
        filename: 'notes.txt',
        url: expect.stringContaining('/uploads/u1/chats/c1/'),
        mediaType: 'text/plain',
        objectKey: expect.stringMatching(/^u1\/chats\/c1\/\d+-notes\.txt$/),
        status: 'pending',
        type: 'file'
      }
    })

    expect(createFileRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        chatId: 'c1',
        filename: 'notes.txt',
        objectKey: json.file.objectKey,
        mediaType: 'text/plain',
        size: Buffer.byteLength(content),
        status: 'pending'
      })
    )

    const written = await readFile(
      path.join(uploadsDir, json.file.objectKey),
      'utf-8'
    )
    expect(written).toBe(content)
  })

  it('runs the fast path (processFileForRAG + markFileReady) for a text file', async () => {
    const req = makeRequest('a'.repeat(500), {
      'content-type': 'text/plain',
      'x-filename': encodeURIComponent('notes.txt'),
      'x-chat-id': 'c1'
    })

    const res = await POST(req)
    expect(res.status).toBe(200)

    await vi.waitFor(() => {
      expect(processFileForRAG).toHaveBeenCalledWith(
        expect.stringContaining(uploadsDir),
        'text/plain',
        'notes.txt'
      )
      expect(markFileReady).toHaveBeenCalledWith('file-1')
    })
  })

  it('does not run the fast path for an mp3 (and falls back to a "none" chat id when absent)', async () => {
    const req = makeRequest('id3-ish bytes', {
      'content-type': 'audio/mpeg',
      'x-filename': encodeURIComponent('song.mp3')
      // no x-chat-id header at all
    })

    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.file.objectKey).toMatch(/^u1\/chats\/none\/\d+-song\.mp3$/)

    // give any fire-and-forget microtask a chance to run before asserting
    // the negative — there's no event to wait on for "never called".
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(processFileForRAG).not.toHaveBeenCalled()
    expect(markFileReady).not.toHaveBeenCalled()
  })

  it('unlinks the written file and returns 500 when createFileRecord fails', async () => {
    vi.mocked(createFileRecord).mockRejectedValue(new Error('db down'))

    const req = makeRequest('hello world', {
      'content-type': 'text/plain',
      'x-filename': encodeURIComponent('notes.txt'),
      'x-chat-id': 'c1'
    })

    const res = await POST(req)

    expect(res.status).toBe(500)
    expect(createFileRecord).toHaveBeenCalledTimes(1)

    // The route must not leave an orphaned (up to 2GB) file behind when the
    // DB write fails — recover the objectKey it attempted to persist and
    // confirm the file no longer exists on disk.
    const { objectKey } = vi.mocked(createFileRecord).mock.calls[0][0]
    await expect(
      readFile(path.join(uploadsDir, objectKey))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('sanitizes a path-traversal x-chat-id so the write stays under UPLOADS_DIR', async () => {
    const content = 'hello world'
    const req = makeRequest(content, {
      'content-type': 'text/plain',
      'x-filename': encodeURIComponent('notes.txt'),
      'x-chat-id': '../../../../evil'
    })

    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.file.objectKey).not.toContain('..')
    // Exactly userId/chats/<sanitized-chat-id>/<file> — no extra separators
    // smuggled in via the header.
    expect(json.file.objectKey.split('/')).toHaveLength(4)

    expect(createFileRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: expect.not.stringContaining('..')
      })
    )

    const absPath = path.join(uploadsDir, json.file.objectKey)
    const uploadsDirReal = await realpath(uploadsDir)
    const absPathReal = await realpath(absPath)
    expect(absPathReal.startsWith(uploadsDirReal + path.sep)).toBe(true)

    const written = await readFile(absPath, 'utf-8')
    expect(written).toBe(content)
  })
})
