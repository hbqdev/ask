import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NETWORK_ERROR_MESSAGE } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'
import { UPLOAD_STALL_MS, uploadFile } from '@/features/compose/upload'

/** A stand-in XMLHttpRequest the test drives by hand. */
class FakeXhr {
  static last: FakeXhr | undefined
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown
  status = 0
  responseText = ''
  aborted = false
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = {
    onprogress: null
  }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  send(body: unknown) {
    this.body = body
    FakeXhr.last = this
  }
  abort() {
    this.aborted = true
    this.onabort?.()
  }

  // Test controls.
  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({
      loaded,
      total,
      lengthComputable
    } as ProgressEvent)
  }
  respond(status: number, body: string) {
    this.status = status
    this.responseText = body
    this.onload?.()
  }
  fail() {
    this.onerror?.()
  }
}

const xhr = () => FakeXhr.last!

const BASE = 'https://ask.test.invalid'
const file = new Blob(['hello'], { type: 'image/png' })

const OK_BODY = JSON.stringify({
  success: true,
  file: {
    id: 'f1',
    filename: 'my photo.png',
    url: 'https://ask.test.invalid/uploads/u1/chats/c1/1-my_photo.png?exp=1&sig=x',
    mediaType: 'image/png',
    objectKey: 'u1/chats/c1/1-my_photo.png',
    status: 'pending',
    type: 'file'
  }
})

beforeEach(() => {
  FakeXhr.last = undefined
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('uploadFile', () => {
  it('POSTs the raw file with the auth, type, name and chat headers', async () => {
    const done = uploadFile({
      baseUrl: BASE,
      token: 'tok',
      file,
      filename: 'my photo.png',
      chatId: 'c1'
    })
    expect(xhr().method).toBe('POST')
    expect(xhr().url).toBe(`${BASE}/api/upload`)
    expect(xhr().body).toBe(file)
    expect(xhr().headers).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': 'image/png',
      'x-filename': 'my%20photo.png',
      'x-chat-id': 'c1'
    })

    xhr().respond(200, OK_BODY)
    await expect(done).resolves.toEqual({
      url: 'https://ask.test.invalid/uploads/u1/chats/c1/1-my_photo.png?exp=1&sig=x',
      filename: 'my photo.png',
      mediaType: 'image/png',
      objectKey: 'u1/chats/c1/1-my_photo.png',
      status: 'pending'
    })
  })

  it('sends no chat header without a chat, and a generic type for an untyped file', async () => {
    const done = uploadFile({
      baseUrl: BASE,
      token: 'tok',
      file: new Blob(['x']),
      filename: 'main.rs'
    })
    expect(xhr().headers).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/octet-stream',
      'x-filename': 'main.rs'
    })
    xhr().respond(200, OK_BODY)
    await done
  })

  it('reports upload progress as a fraction', async () => {
    const onProgress = vi.fn()
    const done = uploadFile({
      baseUrl: BASE,
      token: 'tok',
      file,
      filename: 'a.png',
      onProgress
    })
    xhr().progress(25, 100)
    xhr().progress(5, 0, false) // no length: nothing to report
    xhr().progress(100, 100)
    expect(onProgress.mock.calls).toEqual([[0.25], [1]])
    xhr().respond(200, OK_BODY)
    await done
  })

  it("rejects a 400 with an ApiError carrying the server's message", async () => {
    const done = uploadFile({
      baseUrl: BASE,
      token: 'tok',
      file,
      filename: 'a.exe'
    })
    xhr().respond(400, JSON.stringify({ error: 'Unsupported file type' }))
    const err = await done.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 400, message: 'Unsupported file type' })
  })

  it('rejects a 200 that is not the upload answer', async () => {
    const done = uploadFile({
      baseUrl: BASE,
      token: 'tok',
      file,
      filename: 'a.png'
    })
    xhr().respond(200, '<html>proxy</html>')
    await expect(done).rejects.toMatchObject({
      name: 'ApiError',
      status: 200,
      message: 'Upload failed'
    })
  })

  it('fills what an older server leaves out of its answer', async () => {
    const done = uploadFile({
      baseUrl: BASE,
      token: 'tok',
      file,
      filename: 'a.png'
    })
    xhr().respond(
      200,
      JSON.stringify({ file: { url: '/u/a', objectKey: 'k' } })
    )
    await expect(done).resolves.toEqual({
      url: '/u/a',
      filename: '',
      mediaType: '',
      objectKey: 'k',
      status: 'pending'
    })
  })

  it('rejects a 200 without the uploaded file', async () => {
    const done = uploadFile({
      baseUrl: BASE,
      token: 'tok',
      file,
      filename: 'a.png'
    })
    xhr().respond(200, JSON.stringify({ success: true }))
    await expect(done).rejects.toMatchObject({ message: 'Upload failed' })
  })

  it('rejects a network failure with a status-0 ApiError', async () => {
    const done = uploadFile({
      baseUrl: BASE,
      token: 'tok',
      file,
      filename: 'a.png'
    })
    xhr().fail()
    await expect(done).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      retryable: true
    })
  })

  it('rejects a response with no HTTP status as a network failure', async () => {
    const done = uploadFile({
      baseUrl: BASE,
      token: 'tok',
      file,
      filename: 'a.png'
    })
    xhr().respond(0, '')
    await expect(done).rejects.toMatchObject({ name: 'ApiError', status: 0 })
  })

  it('aborts the request when the signal fires, rejecting with AbortError', async () => {
    const controller = new AbortController()
    const done = uploadFile({
      baseUrl: BASE,
      token: 'tok',
      file,
      filename: 'a.png',
      signal: controller.signal
    })
    controller.abort()
    expect(xhr().aborted).toBe(true)
    await expect(done).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('never sends when the signal has already fired', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      uploadFile({
        baseUrl: BASE,
        token: 'tok',
        file,
        filename: 'a.png',
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeXhr.last).toBeUndefined()
  })

  describe('a stalled upload', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    const start = () =>
      uploadFile({ baseUrl: BASE, token: 'tok', file, filename: 'a.png' })

    it('gives up after 120 s without progress, as a retryable network error', async () => {
      const done = start()
      const settled = vi.fn()
      done.catch(settled)
      await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(xhr().aborted).toBe(true)
      await expect(done).rejects.toMatchObject({
        name: 'ApiError',
        status: 0,
        retryable: true,
        message: NETWORK_ERROR_MESSAGE
      })
      expect(UPLOAD_STALL_MS).toBe(120_000)
    })

    it('waits again from each bit of progress', async () => {
      const done = start()
      const settled = vi.fn()
      done.catch(settled)
      await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1)
      xhr().progress(10, 100)
      await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1)
      expect(settled).not.toHaveBeenCalled()
      xhr().respond(200, OK_BODY)
      await expect(done).resolves.toMatchObject({ filename: 'my photo.png' })
      expect(vi.getTimerCount()).toBe(0)
    })

    it('stops watching once it fails or is cancelled', async () => {
      const failed = start()
      xhr().fail()
      await expect(failed).rejects.toMatchObject({ status: 0 })
      expect(vi.getTimerCount()).toBe(0)

      const controller = new AbortController()
      const cancelled = uploadFile({
        baseUrl: BASE,
        token: 'tok',
        file,
        filename: 'a.png',
        signal: controller.signal
      })
      controller.abort()
      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
