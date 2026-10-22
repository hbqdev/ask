import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { ApiError } from '@/core/api/errors'
import { haptic } from '@/core/haptics'
import {
  CONVERT_FAILED_MESSAGE,
  toUploadable
} from '@/features/compose/image-convert'
import { uploadFile, type UploadResult } from '@/features/compose/upload'
import {
  ingestNote,
  INGEST_POLL_MS,
  MAX_ATTACHMENTS,
  UNSUPPORTED_MESSAGE,
  UPLOAD_FAILED_MESSAGE,
  useAttachments,
  type Attachment
} from '@/features/compose/useAttachments'

vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))
vi.mock('@/features/compose/upload', () => ({ uploadFile: vi.fn() }))
vi.mock('@/features/compose/image-convert', async importOriginal => ({
  ...(await importOriginal<
    typeof import('@/features/compose/image-convert')
  >()),
  toUploadable: vi.fn()
}))

const BASE = 'https://ask.test.invalid'
const getToken = vi.fn<() => Promise<string | null>>()
const clientJson = vi.fn()
const handleUnauthorized = vi.fn(async () => 'stop' as const)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const pdf = (name = 'report.pdf') =>
  new File(['%PDF'], name, { type: 'application/pdf' })
const jpeg = (name = 'photo.jpg') =>
  new File(['jpeg'], name, { type: 'image/jpeg' })

const resultFor = (file: File, status = 'ready'): UploadResult => ({
  url: `${BASE}/uploads/u1/chats/c1/1-${file.name}?exp=1&sig=s`,
  filename: file.name,
  mediaType: file.type,
  objectKey: `u1/chats/c1/1-${file.name}`,
  status
})

let objectUrls = 0
const createObjectURL = vi.fn(() => `blob:preview-${++objectUrls}`)
const revokeObjectURL = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  objectUrls = 0
  getToken.mockResolvedValue('tok')
  vi.mocked(useApi).mockReturnValue({
    baseUrl: BASE,
    getToken,
    client: { json: clientJson },
    handleUnauthorized
  } as unknown as Api)
  vi.mocked(toUploadable).mockImplementation(async file => file)
  vi.mocked(uploadFile).mockImplementation(async ({ file }) =>
    resultFor(file as File)
  )
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const render = (o: { chatId?: string } = { chatId: 'c1' }) =>
  renderHook(() => useAttachments(o.chatId))

describe('useAttachments', () => {
  it('is ready with nothing attached', () => {
    const { result } = render()
    expect(result.current.items).toEqual([])
    expect(result.current.ready).toBe(true)
    expect(result.current.parts()).toEqual([])
  })

  it('takes a file through converting, uploading and done', async () => {
    const conversion = deferred<File>()
    const upload = deferred<UploadResult>()
    vi.mocked(toUploadable).mockReturnValue(conversion.promise)
    vi.mocked(uploadFile).mockReturnValue(upload.promise)
    const heic = new File(['heic'], 'IMG_1.HEIC', { type: 'image/heic' })
    const converted = new File(['jpeg'], 'IMG_1.jpg', { type: 'image/jpeg' })
    const { result } = render()

    act(() => result.current.add([heic]))
    expect(result.current.items).toEqual([
      expect.objectContaining({
        name: 'IMG_1.HEIC',
        status: 'converting',
        progress: 0
      })
    ])
    expect(result.current.ready).toBe(false)
    expect(toUploadable).toHaveBeenCalledWith(heic)

    await act(async () => conversion.resolve(converted))
    expect(result.current.items[0]).toMatchObject({
      name: 'IMG_1.jpg',
      mediaType: 'image/jpeg',
      status: 'uploading',
      previewUrl: 'blob:preview-1'
    })
    expect(createObjectURL).toHaveBeenCalledWith(converted)
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: BASE,
        token: 'tok',
        file: converted,
        filename: 'IMG_1.jpg',
        chatId: 'c1'
      })
    )

    const { onProgress } = vi.mocked(uploadFile).mock.calls[0][0]
    act(() => onProgress!(0.4))
    expect(result.current.items[0].progress).toBe(0.4)

    await act(async () => upload.resolve(resultFor(converted)))
    expect(result.current.items[0]).toMatchObject({
      status: 'done',
      progress: 1,
      result: resultFor(converted)
    })
    expect(result.current.ready).toBe(true)
  })

  it('shows no preview for a file that is not an image', async () => {
    const { result } = render({})
    act(() => result.current.add([pdf()]))
    await waitFor(() => expect(result.current.items[0].status).toBe('done'))
    expect(result.current.items[0].previewUrl).toBeUndefined()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: undefined })
    )
  })

  it('gives a disallowed type an error at once, without uploading it', () => {
    const { result } = render()
    act(() =>
      result.current.add([
        new File(['MZ'], 'setup.exe', { type: 'application/x-msdownload' })
      ])
    )
    expect(result.current.items[0]).toMatchObject({
      name: 'setup.exe',
      status: 'error',
      error: UNSUPPORTED_MESSAGE
    })
    expect(result.current.ready).toBe(false)
    expect(toUploadable).not.toHaveBeenCalled()
    expect(uploadFile).not.toHaveBeenCalled()
    expect(haptic).toHaveBeenCalledWith('error')
  })

  it('checks an untyped file by its name as the server does', async () => {
    const { result } = render()
    act(() => result.current.add([new File(['fn main'], 'main.rs')]))
    await waitFor(() => expect(result.current.items[0].status).toBe('done'))
    expect(result.current.items[0].mediaType).toBe('application/octet-stream')
  })

  it("shows the server's 400 on the chip", async () => {
    vi.mocked(uploadFile).mockRejectedValue(new ApiError(400, 'File too large'))
    const { result } = render()
    act(() => result.current.add([pdf()]))

    await waitFor(() => expect(result.current.items[0].status).toBe('error'))
    expect(result.current.items[0].error).toBe('File too large')
    expect(result.current.ready).toBe(false)
    expect(haptic).toHaveBeenCalledWith('error')
  })

  it('shows a failed conversion, and a generic message for anything else', async () => {
    vi.mocked(toUploadable)
      .mockRejectedValueOnce(new Error(CONVERT_FAILED_MESSAGE))
      .mockRejectedValueOnce(new TypeError('x is undefined'))
    const { result } = render()
    act(() => result.current.add([jpeg('a.jpg'), jpeg('b.jpg')]))

    await waitFor(() =>
      expect(result.current.items.map(i => i.error)).toEqual([
        CONVERT_FAILED_MESSAGE,
        UPLOAD_FAILED_MESSAGE
      ])
    )
  })

  it('fails the upload when signed out, without sending', async () => {
    getToken.mockResolvedValue(null)
    const { result } = render()
    act(() => result.current.add([pdf()]))
    await waitFor(() => expect(result.current.items[0].status).toBe('error'))
    expect(result.current.items[0].error).toBe('Signed out')
    expect(uploadFile).not.toHaveBeenCalled()
  })

  it('retry uploads a failed file again', async () => {
    vi.mocked(uploadFile).mockRejectedValueOnce(
      new ApiError(0, 'Network error. Check your connection.')
    )
    const { result } = render()
    act(() => result.current.add([jpeg()]))
    await waitFor(() => expect(result.current.items[0].status).toBe('error'))
    const { id, previewUrl } = result.current.items[0]

    act(() => result.current.retry(id))
    expect(result.current.items[0]).toMatchObject({
      status: 'converting',
      error: undefined
    })
    await waitFor(() => expect(result.current.items[0].status).toBe('done'))
    expect(uploadFile).toHaveBeenCalledTimes(2)
    // The preview made for the first try is reused.
    expect(result.current.items[0].previewUrl).toBe(previewUrl)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('retry does nothing for a failure retrying cannot fix, or a file that did not fail', async () => {
    vi.mocked(uploadFile)
      .mockRejectedValueOnce(new ApiError(400, 'File too large'))
      .mockImplementation(async ({ file }) => resultFor(file as File))
    const { result } = render()
    act(() =>
      result.current.add([
        new File(['x'], 'a.exe', { type: 'x/y' }),
        pdf('big.pdf'),
        pdf()
      ])
    )
    await waitFor(() => expect(result.current.items[2].status).toBe('done'))
    const [bad, tooLarge, good] = result.current.items
    expect(bad).toMatchObject({ error: UNSUPPORTED_MESSAGE, retryable: false })
    expect(tooLarge).toMatchObject({
      error: 'File too large',
      retryable: false
    })

    act(() => result.current.retry(bad.id))
    act(() => result.current.retry(tooLarge.id))
    act(() => result.current.retry(good.id))
    act(() => result.current.retry('missing'))
    expect(result.current.items.map(i => i.status)).toEqual([
      'error',
      'error',
      'done'
    ])
    expect(uploadFile).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a lost connection', new ApiError(0, 'Network error.'), true],
    ['a server error', new ApiError(500, 'Upload failed'), true],
    ['a gateway error', new ApiError(502, 'Bad gateway'), true],
    ['a cut-off upload', new ApiError(400, 'Upload incomplete'), true],
    ['an unexpected failure', new TypeError('boom'), true],
    ['a refused type', new ApiError(400, 'Unsupported file type'), false],
    ['a file too large', new ApiError(400, 'File too large'), false],
    ['a refused (expired) token', new ApiError(401, 'Unauthorized'), true]
  ])('decides whether %s can be retried', async (_name, error, retryable) => {
    vi.mocked(uploadFile).mockRejectedValue(error)
    const { result } = render()
    act(() => result.current.add([pdf()]))
    await waitFor(() => expect(result.current.items[0].status).toBe('error'))
    expect(result.current.items[0].retryable).toBe(retryable)
  })

  it('a 401 calls the handler and keeps its own message', async () => {
    vi.mocked(uploadFile).mockRejectedValueOnce(
      new ApiError(401, 'Unauthorized')
    )
    const { result } = render()
    act(() => result.current.add([pdf()]))
    await waitFor(() => expect(result.current.items[0].status).toBe('error'))

    expect(handleUnauthorized).toHaveBeenCalledExactlyOnceWith('first')
    expect(result.current.items[0].error).toBe('Unauthorized')
  })

  it('no token (nothing sent) leaves the session alone', async () => {
    getToken.mockResolvedValueOnce(null)
    const { result } = render()
    act(() => result.current.add([pdf()]))
    await waitFor(() => expect(result.current.items[0].status).toBe('error'))

    expect(uploadFile).not.toHaveBeenCalled()
    expect(handleUnauthorized).not.toHaveBeenCalled()
  })

  it('a 401 can be retried, with a fresh token', async () => {
    vi.mocked(uploadFile).mockRejectedValueOnce(
      new ApiError(401, 'Unauthorized')
    )
    getToken.mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh')
    const { result } = render()
    act(() => result.current.add([pdf()]))
    await waitFor(() => expect(result.current.items[0].status).toBe('error'))

    act(() => result.current.retry(result.current.items[0].id))
    await waitFor(() => expect(result.current.items[0].status).toBe('done'))
    expect(vi.mocked(uploadFile).mock.calls.map(([o]) => o.token)).toEqual([
      'stale',
      'fresh'
    ])
  })

  it('a failed conversion can be retried', async () => {
    vi.mocked(toUploadable).mockRejectedValueOnce(
      new Error(CONVERT_FAILED_MESSAGE)
    )
    const { result } = render()
    act(() => result.current.add([jpeg()]))
    await waitFor(() => expect(result.current.items[0].status).toBe('error'))
    expect(result.current.items[0].retryable).toBe(true)

    act(() => result.current.retry(result.current.items[0].id))
    await waitFor(() => expect(result.current.items[0].status).toBe('done'))
    expect(result.current.items[0].retryable).toBeUndefined()
  })

  it('remove cancels the upload and revokes the preview URL', async () => {
    const upload = deferred<UploadResult>()
    vi.mocked(uploadFile).mockReturnValue(upload.promise)
    const { result } = render()
    act(() => result.current.add([jpeg()]))
    await waitFor(() =>
      expect(result.current.items[0].status).toBe('uploading')
    )
    const { signal } = vi.mocked(uploadFile).mock.calls[0][0]

    act(() => result.current.remove(result.current.items[0].id))
    expect(result.current.items).toEqual([])
    expect(signal!.aborted).toBe(true)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
    expect(result.current.ready).toBe(true)

    // The cancelled upload's rejection changes nothing.
    await act(async () =>
      upload.reject(new DOMException('cancelled', 'AbortError'))
    )
    expect(result.current.items).toEqual([])
    expect(haptic).not.toHaveBeenCalled()
  })

  it('converts one picked file at a time, while uploads run side by side', async () => {
    const conversions: Array<ReturnType<typeof deferred<File>>> = []
    let converting = 0
    let mostAtOnce = 0
    vi.mocked(toUploadable).mockImplementation(file => {
      const conversion = deferred<File>()
      conversions.push(conversion)
      mostAtOnce = Math.max(mostAtOnce, ++converting)
      return conversion.promise.finally(() => converting--)
    })
    vi.mocked(uploadFile).mockReturnValue(new Promise(() => {}))
    const picked = Array.from({ length: 10 }, (_, i) => jpeg(`p${i}.jpg`))
    const { result } = render()

    act(() => result.current.add(picked))
    expect(toUploadable).toHaveBeenCalledTimes(1)

    for (let i = 0; i < picked.length; i++) {
      expect(toUploadable).toHaveBeenCalledTimes(i + 1)
      expect(vi.mocked(toUploadable).mock.calls[i][0]).toBe(picked[i])
      await act(async () => conversions[i].resolve(picked[i]))
    }
    expect(mostAtOnce).toBe(1)
    // Every file went on to upload without waiting for the others' uploads.
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(10))
  })

  it('never converts a file removed while it waited its turn', async () => {
    const first = deferred<File>()
    vi.mocked(toUploadable).mockReturnValueOnce(first.promise)
    const { result } = render()
    act(() => result.current.add([jpeg('a.jpg'), jpeg('b.jpg')]))
    act(() => result.current.remove(result.current.items[1].id))

    await act(async () => first.resolve(jpeg('a.jpg')))
    expect(toUploadable).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(result.current.items[0].status).toBe('done'))
  })

  it('drops a conversion that finishes after the file was removed', async () => {
    const conversion = deferred<File>()
    vi.mocked(toUploadable).mockReturnValue(conversion.promise)
    const { result } = render()
    act(() => result.current.add([jpeg()]))
    act(() => result.current.remove(result.current.items[0].id))

    await act(async () => conversion.resolve(jpeg()))
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(uploadFile).not.toHaveBeenCalled()
  })

  it('drops an upload whose token arrives after the file was removed', async () => {
    const token = deferred<string | null>()
    getToken.mockReturnValue(token.promise)
    const { result } = render()
    act(() => result.current.add([pdf()]))
    await waitFor(() => expect(getToken).toHaveBeenCalled())
    act(() => result.current.remove(result.current.items[0].id))

    await act(async () => token.resolve('tok'))
    expect(uploadFile).not.toHaveBeenCalled()
  })

  it(`keeps at most ${MAX_ATTACHMENTS} attachments`, async () => {
    expect(MAX_ATTACHMENTS).toBe(10)
    const { result } = render()
    act(() =>
      result.current.add(
        Array.from({ length: 8 }, (_, i) => pdf(`doc${i}.pdf`))
      )
    )
    act(() =>
      result.current.add(
        Array.from({ length: 4 }, (_, i) => pdf(`more${i}.pdf`))
      )
    )
    expect(result.current.overLimit).toBe(true)
    expect(result.current.items.map(i => i.name)).toEqual([
      ...Array.from({ length: 8 }, (_, i) => `doc${i}.pdf`),
      'more0.pdf',
      'more1.pdf'
    ])
    act(() => result.current.add([pdf('one-too-many.pdf')]))
    expect(result.current.items).toHaveLength(10)
    await waitFor(() => expect(result.current.ready).toBe(true))
  })
  it('says so when picks go over the limit, until there is room again', async () => {
    const { result } = render()
    act(() =>
      result.current.add(Array.from({ length: 10 }, (_, i) => pdf(`${i}.pdf`)))
    )
    // Exactly at the limit is not over it.
    expect(result.current.overLimit).toBe(false)

    act(() => result.current.add([pdf('eleven.pdf')]))
    expect(result.current.overLimit).toBe(true)
    expect(result.current.items).toHaveLength(10)

    act(() => result.current.remove(result.current.items[0].id))
    expect(result.current.overLimit).toBe(false)

    act(() => result.current.add([pdf('a.pdf'), pdf('b.pdf')]))
    expect(result.current.overLimit).toBe(true)
    act(() => result.current.clear())
    expect(result.current.overLimit).toBe(false)
    await act(async () => {})
  })

  it('takes a FileList as the input hands it over', async () => {
    const list = {
      0: pdf(),
      length: 1,
      item: (i: number) => (i === 0 ? pdf() : null),
      [Symbol.iterator]: function* () {
        yield pdf()
      }
    } as unknown as FileList
    const { result } = render()
    act(() => result.current.add(list))
    expect(result.current.items).toHaveLength(1)
    await waitFor(() => expect(result.current.ready).toBe(true))
  })

  it('parts() lists the uploaded files for the chat request', async () => {
    const { result } = render()
    const photo = jpeg()
    const doc = pdf()
    act(() => result.current.add([photo, doc]))
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.parts()).toEqual([
      {
        url: resultFor(photo).url,
        filename: 'photo.jpg',
        mediaType: 'image/jpeg'
      },
      {
        url: resultFor(doc).url,
        filename: 'report.pdf',
        mediaType: 'application/pdf'
      }
    ])
  })

  it('parts() leaves out a file still uploading', async () => {
    vi.mocked(uploadFile)
      .mockImplementationOnce(async ({ file }) => resultFor(file as File))
      .mockReturnValueOnce(new Promise(() => {}))
    const { result } = render()
    act(() => result.current.add([pdf('a.pdf'), pdf('b.pdf')]))
    await waitFor(() => expect(result.current.items[0].status).toBe('done'))

    expect(result.current.parts().map(p => p.filename)).toEqual(['a.pdf'])
  })

  it('clear empties the list, cancelling uploads and revoking previews', async () => {
    const upload = deferred<UploadResult>()
    vi.mocked(uploadFile)
      .mockImplementationOnce(async ({ file }) => resultFor(file as File))
      .mockReturnValueOnce(upload.promise)
    const { result } = render()
    act(() => result.current.add([jpeg('a.jpg'), jpeg('b.jpg')]))
    await waitFor(() =>
      expect(result.current.items.map(i => i.status)).toEqual([
        'done',
        'uploading'
      ])
    )
    const { signal } = vi.mocked(uploadFile).mock.calls[1][0]

    act(() => result.current.clear())
    expect(result.current.items).toEqual([])
    expect(signal!.aborted).toBe(true)
    expect(revokeObjectURL.mock.calls).toEqual([
      ['blob:preview-1'],
      ['blob:preview-2']
    ])
    // The count starts again from nothing.
    act(() =>
      result.current.add(Array.from({ length: 10 }, (_, i) => pdf(`${i}.pdf`)))
    )
    expect(result.current.items).toHaveLength(10)
  })

  it('cancels uploads and revokes previews on unmount', async () => {
    const upload = deferred<UploadResult>()
    vi.mocked(uploadFile).mockReturnValue(upload.promise)
    const { result, unmount } = render()
    act(() => result.current.add([jpeg()]))
    await waitFor(() =>
      expect(result.current.items[0].status).toBe('uploading')
    )
    const { signal } = vi.mocked(uploadFile).mock.calls[0][0]

    unmount()
    expect(signal!.aborted).toBe(true)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
  })

  describe('indexing status', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    async function uploadedPending(name = 'big.csv') {
      vi.mocked(uploadFile).mockImplementation(async ({ file }) =>
        resultFor(file as File, 'processing')
      )
      const hook = render()
      act(() =>
        hook.result.current.add([new File(['a,b'], name, { type: 'text/csv' })])
      )
      await act(async () => {})
      expect(hook.result.current.items[0].status).toBe('done')
      return hook
    }

    it('polls every 3 s while a file is still being indexed, then stops', async () => {
      expect(INGEST_POLL_MS).toBe(3000)
      const { result } = await uploadedPending()
      const key = 'u1/chats/c1/1-big.csv'
      clientJson.mockResolvedValueOnce({
        statuses: [
          {
            objectKey: key,
            status: 'processing',
            ingestStage: 'chunking',
            ingestError: null
          }
        ]
      })
      clientJson.mockResolvedValueOnce({
        statuses: [
          {
            objectKey: key,
            status: 'ready',
            ingestStage: null,
            ingestError: 'Indexed the first part only (file too large)'
          }
        ]
      })
      expect(ingestNote(result.current.items[0])).toBe('Processing…')

      await act(() => vi.advanceTimersByTimeAsync(INGEST_POLL_MS))
      expect(clientJson).toHaveBeenCalledWith(
        `/api/files/status?keys=${encodeURIComponent(key)}`
      )
      expect(result.current.items[0].ingestStatus).toBe('processing')

      await act(() => vi.advanceTimersByTimeAsync(INGEST_POLL_MS))
      expect(result.current.items[0]).toMatchObject({
        ingestStatus: 'ready',
        ingestError: 'Indexed the first part only (file too large)'
      })
      expect(ingestNote(result.current.items[0])).toBe(
        'Indexed the first part only (file too large)'
      )

      await act(() => vi.advanceTimersByTimeAsync(INGEST_POLL_MS * 3))
      expect(clientJson).toHaveBeenCalledTimes(2)
    })

    it('keeps polling through a failed poll, and stops on unmount', async () => {
      const { unmount } = await uploadedPending()
      clientJson.mockRejectedValueOnce(new ApiError(0, 'offline'))
      clientJson.mockResolvedValue({ statuses: [] })

      await act(() => vi.advanceTimersByTimeAsync(INGEST_POLL_MS * 2))
      expect(clientJson).toHaveBeenCalledTimes(2)

      unmount()
      await act(() => vi.advanceTimersByTimeAsync(INGEST_POLL_MS * 3))
      expect(clientJson).toHaveBeenCalledTimes(2)
    })

    it('does not poll for a file that is already indexed', async () => {
      const { result } = render()
      act(() => result.current.add([pdf()]))
      await act(async () => {})
      expect(result.current.items[0].ingestStatus).toBe('ready')

      await act(() => vi.advanceTimersByTimeAsync(INGEST_POLL_MS * 2))
      expect(clientJson).not.toHaveBeenCalled()
    })
  })
})

describe('ingestNote', () => {
  const base: Attachment = {
    id: 'a',
    name: 'f.pdf',
    mediaType: 'application/pdf',
    progress: 1,
    status: 'done'
  }

  it('says what the indexing of an uploaded file came to', () => {
    expect(ingestNote({ ...base, ingestStatus: 'pending' })).toBe('Processing…')
    expect(ingestNote({ ...base, ingestStatus: 'processing' })).toBe(
      'Processing…'
    )
    expect(ingestNote({ ...base, ingestStatus: 'ready' })).toBeUndefined()
    expect(ingestNote({ ...base, ingestStatus: 'failed' })).toBe(
      "Couldn't read this file"
    )
    expect(ingestNote({ ...base, ingestStatus: 'expired' })).toBe(
      "Couldn't read this file"
    )
    expect(ingestNote(base)).toBeUndefined()
  })

  it('says nothing about a file that is not uploaded yet', () => {
    expect(
      ingestNote({ ...base, status: 'uploading', ingestStatus: 'pending' })
    ).toBeUndefined()
  })
})
