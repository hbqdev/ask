// One attachment's upload to Ask (code map §6): the raw bytes POSTed to
// /api/upload, named in x-filename and filed under the chat in x-chat-id. It
// uses XHR rather than fetch because only XHR reports upload progress. The
// route answers the app's CORS itself, outside the proxy, so a large file
// arrives whole.

import { NETWORK_ERROR_MESSAGE } from '@/core/api/client'
import { ApiError, toApiError } from '@/core/api/errors'

export type UploadOptions = {
  baseUrl: string
  token: string
  file: Blob
  filename: string
  chatId?: string
  /** The fraction of the bytes sent so far, 0 to 1. */
  onProgress?(fraction: number): void
  signal?: AbortSignal
}

export type UploadResult = {
  /** The file's signed URL, which the chat request carries. */
  url: string
  filename: string
  mediaType: string
  /** The key /api/files/status reports the file's indexing under. */
  objectKey: string
  /** Its indexing state when the upload finished: 'pending' or 'processing'. */
  status: string
}

type UploadResponse = { file?: Partial<UploadResult> }

const networkError = () =>
  new ApiError(0, NETWORK_ERROR_MESSAGE, { retryable: true })

const abortError = () =>
  new DOMException('The upload was cancelled.', 'AbortError')

function parseUpload(text: string): UploadResult | undefined {
  try {
    const { file } = JSON.parse(text) as UploadResponse
    if (!file?.url || !file.objectKey) return undefined
    return {
      url: file.url,
      filename: file.filename ?? '',
      mediaType: file.mediaType ?? '',
      objectKey: file.objectKey,
      status: file.status ?? 'pending'
    }
  } catch {
    return undefined
  }
}

export function uploadFile({
  baseUrl,
  token,
  file,
  filename,
  chatId,
  onProgress,
  signal
}: UploadOptions): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())

    const xhr = new XMLHttpRequest()
    const onAbort = () => xhr.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const settle = () => signal?.removeEventListener('abort', onAbort)

    xhr.open('POST', `${baseUrl}/api/upload`)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    // Ask's allowlist reads the type; an untyped file goes as the web sends it.
    xhr.setRequestHeader(
      'Content-Type',
      file.type || 'application/octet-stream'
    )
    xhr.setRequestHeader('x-filename', encodeURIComponent(filename))
    if (chatId) xhr.setRequestHeader('x-chat-id', chatId)

    xhr.upload.onprogress = e => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total)
    }
    xhr.onload = () => {
      settle()
      if (xhr.status >= 200 && xhr.status < 300) {
        const result = parseUpload(xhr.responseText)
        return result
          ? resolve(result)
          : reject(new ApiError(xhr.status, 'Upload failed'))
      }
      // No HTTP status (a WebView quirk) reads as the network failing.
      if (xhr.status < 200 || xhr.status > 599) return reject(networkError())
      // Ask's {error} (or plain text) becomes the message shown on the chip.
      void toApiError(
        new Response(xhr.responseText, { status: xhr.status })
      ).then(reject)
    }
    xhr.onerror = () => {
      settle()
      reject(networkError())
    }
    xhr.onabort = () => {
      settle()
      reject(abortError())
    }
    xhr.send(file)
  })
}
