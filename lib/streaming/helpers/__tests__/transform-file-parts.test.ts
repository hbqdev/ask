import type { UIMessage } from 'ai'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
vi.mock('@/lib/db/file-actions')
vi.mock('@/lib/embeddings/upload-rag')

// The pdftotext fallback (preserved from the current implementation) shells
// out via a *dynamic* `await import('node:child_process')` inside a
// try/catch, then `promisify()`s `execFile`. Mocking the module at the top
// level and exposing the promisified form via `util.promisify.custom` lets
// us control its output deterministically without depending on poppler-utils
// being installed wherever these tests run.
const { execFileMock, mockPdftotext } = vi.hoisted(() => {
  const mockPdftotext = vi.fn()
  const execFileMock: any = vi.fn()
  execFileMock[Symbol.for('nodejs.util.promisify.custom')] = mockPdftotext
  return { execFileMock, mockPdftotext }
})
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: execFileMock,
    default: { ...actual, execFile: execFileMock }
  }
})

import { findFileByObjectKey } from '@/lib/db/file-actions'
import { queryFileChunks } from '@/lib/embeddings/upload-rag'

// transform-file-parts.ts reads process.env.UPLOADS_DIR into a module-level
// const, so the env var must be set *before* the module is first evaluated —
// hence the dynamic import inside beforeAll (mirrors app/api/upload's test).
let uploadsDir: string
let transformFileParts: typeof import('../transform-file-parts').transformFileParts

beforeAll(async () => {
  uploadsDir = await mkdtemp(path.join(tmpdir(), 'ask-transform-file-parts-'))
  process.env.UPLOADS_DIR = uploadsDir
  vi.resetModules()
  ;({ transformFileParts } = await import('../transform-file-parts'))
})

afterAll(async () => {
  await rm(uploadsDir, { recursive: true, force: true })
})

beforeEach(() => {
  vi.resetAllMocks()
})

function fileUrl(objectKey: string): string {
  return `http://localhost:3000/uploads/${objectKey}`
}

async function writeUploadFile(
  objectKey: string,
  content: string | Buffer
): Promise<string> {
  const fullPath = path.join(uploadsDir, objectKey)
  await mkdir(path.dirname(fullPath), { recursive: true })
  await writeFile(fullPath, content)
  return fullPath
}

async function makeUploadDir(objectKey: string): Promise<string> {
  const fullPath = path.join(uploadsDir, objectKey)
  await mkdir(fullPath, { recursive: true })
  return fullPath
}

function filePart(objectKey: string, over: Partial<any> = {}) {
  return {
    type: 'file',
    url: fileUrl(objectKey),
    filename: objectKey.split('/').pop(),
    mediaType: 'text/plain',
    ...over
  }
}

async function run(
  parts: any[],
  opts?: { modelHasVision?: boolean }
): Promise<any[]> {
  const msg = { id: 'm1', role: 'user', parts } as unknown as UIMessage
  const [result] = await transformFileParts([msg], opts)
  return ((result as any).parts ?? []) as any[]
}

describe('transformFileParts', () => {
  it('leaves non-file parts and non-upload-URL file parts untouched', async () => {
    const textPart = { type: 'text', text: 'hello' }
    const foreignFilePart = filePart('irrelevant', {
      url: 'https://example.com/not-uploads/x.png'
    })

    const result = await run([textPart, foreignFilePart])

    expect(result).toEqual([textPart, foreignFilePart])
    expect(findFileByObjectKey).not.toHaveBeenCalled()
  })

  // ── pending / processing ──────────────────────────────────────────────────

  it('pending status yields a still-processing note, falling back to stage "queued"', async () => {
    vi.mocked(findFileByObjectKey).mockResolvedValue({
      status: 'pending',
      ingestStage: null
    } as any)

    const result = await run([filePart('u1/chats/c1/pending-notxt.txt')])

    expect(result).toEqual([
      {
        type: 'text',
        text: '[Attached file: pending-notxt.txt — still being processed (queued). Its content is not available yet; tell the user to ask again shortly.]'
      }
    ])
  })

  it('processing status uses the explicit ingestStage when present', async () => {
    vi.mocked(findFileByObjectKey).mockResolvedValue({
      status: 'processing',
      ingestStage: 'embedding'
    } as any)

    const result = await run([filePart('u1/chats/c1/processing-notxt.txt')])

    expect(result).toEqual([
      {
        type: 'text',
        text: '[Attached file: processing-notxt.txt — still being processed (embedding). Its content is not available yet; tell the user to ask again shortly.]'
      }
    ])
  })

  // ── failed ─────────────────────────────────────────────────────────────────

  it('failed status yields a failure note, falling back to "unknown error"', async () => {
    vi.mocked(findFileByObjectKey).mockResolvedValue({
      status: 'failed',
      ingestError: null
    } as any)

    const result = await run([filePart('u1/chats/c1/failed-notxt.txt')])

    expect(result).toEqual([
      {
        type: 'text',
        text: '[Attached file: failed-notxt.txt — processing failed: unknown error.]'
      }
    ])
  })

  it('failed status uses the explicit ingestError when present', async () => {
    vi.mocked(findFileByObjectKey).mockResolvedValue({
      status: 'failed',
      ingestError: 'OCR timeout'
    } as any)

    const result = await run([filePart('u1/chats/c1/failed2-notxt.txt')])

    expect(result).toEqual([
      {
        type: 'text',
        text: '[Attached file: failed2-notxt.txt — processing failed: OCR timeout.]'
      }
    ])
  })

  // ── ready, but missing on disk ───────────────────────────────────────────

  it('ready status with file missing on disk yields a no-longer-available note (not a silent drop)', async () => {
    vi.mocked(findFileByObjectKey).mockResolvedValue({
      status: 'ready'
    } as any)

    const result = await run([filePart('u1/chats/c1/missing-notxt.txt')])

    expect(result).toEqual([
      {
        type: 'text',
        text: '[Attached file: missing-notxt.txt — file is no longer available.]'
      }
    ])
  })

  it('no row (pre-feature upload) is treated as ready; missing file still yields the honest note', async () => {
    vi.mocked(findFileByObjectKey).mockResolvedValue(null)

    const result = await run([filePart('u1/chats/c1/prefeature-notxt.txt')])

    expect(result).toEqual([
      {
        type: 'text',
        text: '[Attached file: prefeature-notxt.txt — file is no longer available.]'
      }
    ])
  })

  it('a rejected findFileByObjectKey degrades to the ready path instead of failing the turn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(findFileByObjectKey).mockRejectedValue(
      new Error('connection terminated unexpectedly')
    )
    vi.mocked(queryFileChunks).mockResolvedValue({
      filename: 'report.docx',
      chunks: ['Q1 revenue grew 12%.']
    })
    const objectKey = 'u1/chats/c1/db-down.docx'
    await writeUploadFile(objectKey, 'irrelevant on-disk bytes')

    const result = await run([
      filePart(objectKey, {
        mediaType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename: 'db-down.docx'
      })
    ])

    // Renders via the same ready/excerpts path as a genuine no-row upload —
    // the DB error never propagates and never 500s the turn.
    expect(result).toEqual([
      {
        type: 'text',
        text: '[Attached document: db-down.docx]\n\nRelevant excerpts:\n\nQ1 revenue grew 12%.'
      }
    ])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  // ── ready image ───────────────────────────────────────────────────────────

  it('vision model: ready image with chunks yields extracted text plus the base64 file part', async () => {
    vi.mocked(findFileByObjectKey).mockResolvedValue({ status: 'ready' } as any)
    vi.mocked(queryFileChunks).mockResolvedValue({
      filename: 'photo.png',
      chunks: ['a cat on a mat', 'sitting in the sun']
    })
    const objectKey = 'u1/chats/c1/photo.png'
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03])
    await writeUploadFile(objectKey, bytes)

    const result = await run(
      [filePart(objectKey, { mediaType: 'image/png', filename: 'photo.png' })],
      { modelHasVision: true }
    )

    expect(result).toEqual([
      {
        type: 'text',
        text: '[Attached image: photo.png]\n\nExtracted content:\n\na cat on a mat\n\n---\n\nsitting in the sun'
      },
      {
        type: 'file',
        url: `data:image/png;base64,${bytes.toString('base64')}`,
        filename: 'photo.png',
        mediaType: 'image/png'
      }
    ])
  })

  it('non-vision model: ready image with chunks yields ONLY the extracted text, never the base64', async () => {
    vi.mocked(findFileByObjectKey).mockResolvedValue({ status: 'ready' } as any)
    vi.mocked(queryFileChunks).mockResolvedValue({
      filename: 'photo.png',
      chunks: ['a cat on a mat']
    })
    const objectKey = 'u1/chats/c1/photo-nv.png'
    await writeUploadFile(
      objectKey,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01])
    )

    const result = await run(
      [filePart(objectKey, { mediaType: 'image/png', filename: 'photo.png' })],
      { modelHasVision: false }
    )

    expect(result).toEqual([
      {
        type: 'text',
        text: '[Attached image: photo.png]\n\nExtracted content:\n\na cat on a mat'
      }
    ])
    expect(result.some(p => typeof p.url === 'string')).toBe(false)
  })

  it('vision model: ready image without chunks yields only the base64 file part', async () => {
    vi.mocked(findFileByObjectKey).mockResolvedValue({ status: 'ready' } as any)
    vi.mocked(queryFileChunks).mockResolvedValue(null)
    const objectKey = 'u1/chats/c1/photo2.png'
    const bytes = Buffer.from('not-really-a-png')
    await writeUploadFile(objectKey, bytes)

    const result = await run(
      [filePart(objectKey, { mediaType: 'image/png', filename: 'photo2.png' })],
      { modelHasVision: true }
    )

    expect(result).toEqual([
      {
        type: 'file',
        url: `data:image/png;base64,${bytes.toString('base64')}`,
        filename: 'photo2.png',
        mediaType: 'image/png'
      }
    ])
  })

  it('non-vision model: ready image without chunks yields an honest note (no base64, no silent drop)', async () => {
    vi.mocked(findFileByObjectKey).mockResolvedValue({ status: 'ready' } as any)
    vi.mocked(queryFileChunks).mockResolvedValue(null)
    const objectKey = 'u1/chats/c1/photo2-nv.png'
    await writeUploadFile(objectKey, Buffer.from('not-really-a-png'))

    const result = await run(
      [filePart(objectKey, { mediaType: 'image/png', filename: 'photo2.png' })],
      { modelHasVision: false }
    )

    expect(result).toEqual([
      {
        type: 'text',
        text: '[Attached image: photo2.png — no extractable text is available and the selected model cannot view images.]'
      }
    ])
  })

  it('ready image whose base64 read fails keeps the extracted text and never throws', async () => {
    vi.mocked(findFileByObjectKey).mockResolvedValue({ status: 'ready' } as any)
    vi.mocked(queryFileChunks).mockResolvedValue({
      filename: 'photo3.png',
      chunks: ['only text survives']
    })
    const objectKey = 'u1/chats/c1/photo3.png'
    // fs.access() succeeds on a directory (fileExists → true) but
    // fs.readFile() on a directory throws EISDIR — a realistic way to
    // exercise the "exists but unreadable" race without mocking node:fs.
    await makeUploadDir(objectKey)

    const result = await run(
      [filePart(objectKey, { mediaType: 'image/png', filename: 'photo3.png' })],
      { modelHasVision: true }
    )

    expect(result).toEqual([
      {
        type: 'text',
        text: '[Attached image: photo3.png]\n\nExtracted content:\n\nonly text survives'
      }
    ])
  })

  // ── ready non-image ───────────────────────────────────────────────────────

  it('ready non-image with chunks yields an excerpts injection and queries with the sibling text as the query', async () => {
    vi.mocked(findFileByObjectKey).mockResolvedValue({ status: 'ready' } as any)
    vi.mocked(queryFileChunks).mockResolvedValue({
      filename: 'report.docx',
      chunks: ['Q1 revenue grew 12%.', 'Q2 guidance was raised.']
    })
    const objectKey = 'u1/chats/c1/report.docx'
    const localPath = await writeUploadFile(
      objectKey,
      'irrelevant on-disk bytes'
    )

    const result = await run([
      { type: 'text', text: 'what were the quarterly results?' },
      filePart(objectKey, {
        mediaType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename: 'report.docx'
      })
    ])

    // The sibling user text part and the file's injected text part are both
    // type "text", so the (pre-existing, unrelated) consecutive-text-merge
    // in transformFileParts joins them with "\n\n" — assert on the whole
    // merged string rather than assuming the file injection stands alone.
    expect(result).toEqual([
      {
        type: 'text',
        text:
          'what were the quarterly results?\n\n' +
          '[Attached document: report.docx]\n\nRelevant excerpts:\n\n' +
          'Q1 revenue grew 12%.\n\n---\n\nQ2 guidance was raised.'
      }
    ])
    expect(queryFileChunks).toHaveBeenCalledWith(
      localPath,
      'what were the quarterly results?',
      10
    )
  })

  it('ready PDF without chunks falls back to the preserved pdftotext extraction, querying chunks only once', async () => {
    vi.mocked(findFileByObjectKey).mockResolvedValue({ status: 'ready' } as any)
    vi.mocked(queryFileChunks).mockResolvedValue(null)
    mockPdftotext.mockResolvedValue({
      stdout:
        'Extracted full PDF body text that is long enough to pass the fifty character floor.',
      stderr: ''
    })
    const objectKey = 'u1/chats/c1/doc.pdf'
    await writeUploadFile(objectKey, '%PDF-1.4 fake bytes')

    const result = await run([
      filePart(objectKey, { mediaType: 'application/pdf', filename: 'doc.pdf' })
    ])

    expect(result).toEqual([
      {
        type: 'text',
        text: '[Attached document: doc.pdf]\n\nExtracted full PDF body text that is long enough to pass the fifty character floor.'
      }
    ])
    expect(queryFileChunks).toHaveBeenCalledTimes(1)
  })

  it('ready PDF without chunks and a failing pdftotext yields the preserved "could not extract" document note', async () => {
    vi.mocked(findFileByObjectKey).mockResolvedValue({ status: 'ready' } as any)
    vi.mocked(queryFileChunks).mockResolvedValue(null)
    mockPdftotext.mockRejectedValue(new Error('pdftotext: command not found'))
    const objectKey = 'u1/chats/c1/broken.pdf'
    await writeUploadFile(objectKey, '%PDF-1.4 fake bytes')

    const result = await run([
      filePart(objectKey, {
        mediaType: 'application/pdf',
        filename: 'broken.pdf'
      })
    ])

    expect(result).toEqual([
      {
        type: 'text',
        text: '[Attached document: broken.pdf]\n\n(Could not extract content.)'
      }
    ])
  })

  it('ready non-PDF, non-image without chunks yields the generic "could not extract" file note and never shells out', async () => {
    vi.mocked(findFileByObjectKey).mockResolvedValue({ status: 'ready' } as any)
    vi.mocked(queryFileChunks).mockResolvedValue(null)
    const objectKey = 'u1/chats/c1/song.mp3'
    await writeUploadFile(objectKey, 'not really audio')

    const result = await run([
      filePart(objectKey, { mediaType: 'audio/mpeg', filename: 'song.mp3' })
    ])

    expect(result).toEqual([
      {
        type: 'text',
        text: '[Attached file: song.mp3]\n\n(Could not extract content.)'
      }
    ])
    expect(execFileMock).not.toHaveBeenCalled()
    expect(mockPdftotext).not.toHaveBeenCalled()
  })
})
