// The attachments of the question being written: each picked file is checked
// against Ask's allowlist (the server's own rule), made uploadable (HEIC to
// JPEG, oversized photos scaled) and uploaded at once, with its progress.
// Files stay in memory only. Once uploaded, a file still being indexed is
// polled so its chip can say so; sending does not wait for that (the server
// waits for the indexing itself).

import { useCallback, useEffect, useRef, useState } from 'react'

import { useApi } from '@/core/api/ApiProvider'
import { SIGNED_OUT_MESSAGE } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'
import { haptic } from '@/core/haptics'
import { newId } from '@/core/ids'
import {
  CONVERT_FAILED_MESSAGE,
  isHeic,
  toUploadable
} from '@/features/compose/image-convert'
import { uploadFile, type UploadResult } from '@/features/compose/upload'
import type { FilePart } from '@/features/thread/chat-body'
import { isAllowedUpload } from '@/lib/config/upload-allowlist'

export type AttachmentStatus = 'converting' | 'uploading' | 'done' | 'error'

export type Attachment = {
  id: string
  name: string
  mediaType: string
  /** An object URL of an image, for its thumbnail. */
  previewUrl?: string
  /** The fraction uploaded, 0 to 1. */
  progress: number
  status: AttachmentStatus
  /** Why it failed, for its chip. */
  error?: string
  /** The uploaded file, once done. */
  result?: UploadResult
  /** The server's indexing of the uploaded file (pending, processing, ready, failed, expired). */
  ingestStatus?: string
  /** The server's note on the indexing, such as a partial index. */
  ingestError?: string
}

export type Attachments = {
  items: Attachment[]
  add(files: FileList | File[]): void
  remove(id: string): void
  retry(id: string): void
  /** Nothing is attached, or everything attached is uploaded. */
  ready: boolean
  /** The uploaded files, for the chat request. */
  parts(): FilePart[]
  clear(): void
}

export const MAX_ATTACHMENTS = 10
export const INGEST_POLL_MS = 3000
/** /api/files/status answers for at most this many keys. */
const MAX_STATUS_KEYS = 20
export const UNSUPPORTED_MESSAGE = "This type of file can't be attached"
export const UPLOAD_FAILED_MESSAGE = "Couldn't upload this file"

const OCTET_STREAM = 'application/octet-stream'

type StatusResponse = {
  statuses: Array<{
    objectKey: string
    status: string
    ingestError: string | null
  }>
}

/** The server's rule; a HEIC photo passes because it is sent as a JPEG. */
const isAttachable = (file: File) =>
  isHeic(file) || isAllowedUpload(file.type || OCTET_STREAM, file.name)

const isIndexing = (item: Attachment) =>
  item.status === 'done' &&
  (item.ingestStatus === 'pending' || item.ingestStatus === 'processing')

function failureMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error && err.message === CONVERT_FAILED_MESSAGE) {
    return err.message
  }
  return UPLOAD_FAILED_MESSAGE
}

/** What the chip says about an uploaded file's indexing, if anything. */
export function ingestNote(item: Attachment): string | undefined {
  if (item.status !== 'done') return undefined
  switch (item.ingestStatus) {
    case 'pending':
    case 'processing':
      return 'Processing…'
    case 'failed':
    case 'expired':
      return "Couldn't read this file"
    default:
      return item.ingestError || undefined
  }
}

export function useAttachments(chatId?: string): Attachments {
  const { client, baseUrl, getToken } = useApi()
  const [items, setItems] = useState<Attachment[]>([])
  // The picked files by id, kept for a retry; their count is the cap's.
  const files = useRef(new Map<string, File>())
  const uploads = useRef(new Map<string, AbortController>())
  const previews = useRef(new Map<string, string>())
  const live = useRef({ chatId, baseUrl, getToken })
  useEffect(() => {
    live.current = { chatId, baseUrl, getToken }
  }, [chatId, baseUrl, getToken])
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const update = useCallback((id: string, patch: Partial<Attachment>) => {
    setItems(current =>
      current.map(item => (item.id === id ? { ...item, ...patch } : item))
    )
  }, [])

  const fail = useCallback(
    (id: string, error: string) => {
      haptic('error')
      update(id, { status: 'error', error })
    },
    [update]
  )

  const upload = useCallback(
    async (id: string, picked: File) => {
      const controller = new AbortController()
      uploads.current.set(id, controller)
      const { signal } = controller
      update(id, { status: 'converting', progress: 0, error: undefined })
      try {
        const file = await toUploadable(picked)
        if (signal.aborted) return
        let previewUrl = previews.current.get(id)
        if (!previewUrl && file.type.startsWith('image/')) {
          previewUrl = URL.createObjectURL(file)
          previews.current.set(id, previewUrl)
        }
        update(id, {
          status: 'uploading',
          name: file.name,
          mediaType: file.type || OCTET_STREAM,
          previewUrl
        })
        const token = await live.current.getToken()
        if (signal.aborted) return
        if (!token) throw new ApiError(401, SIGNED_OUT_MESSAGE)
        const result = await uploadFile({
          baseUrl: live.current.baseUrl,
          token,
          file,
          filename: file.name,
          chatId: live.current.chatId,
          onProgress: progress => update(id, { progress }),
          signal
        })
        update(id, {
          status: 'done',
          progress: 1,
          result,
          ingestStatus: result.status
        })
      } catch (err) {
        if (!signal.aborted) fail(id, failureMessage(err))
      } finally {
        if (uploads.current.get(id) === controller) uploads.current.delete(id)
      }
    },
    [update, fail]
  )

  const add = useCallback(
    (list: FileList | File[]) => {
      const room = MAX_ATTACHMENTS - files.current.size
      const picked = Array.from(list).slice(0, Math.max(0, room))
      const added = picked.map(file => {
        const id = newId()
        files.current.set(id, file)
        return { id, file, allowed: isAttachable(file) }
      })
      setItems(current => [
        ...current,
        ...added.map(
          ({ id, file }): Attachment => ({
            id,
            name: file.name,
            mediaType: file.type || OCTET_STREAM,
            progress: 0,
            status: 'converting'
          })
        )
      ])
      for (const { id, file, allowed } of added) {
        if (allowed) void upload(id, file)
        else fail(id, UNSUPPORTED_MESSAGE)
      }
    },
    [upload, fail]
  )

  const retry = useCallback(
    (id: string) => {
      const file = files.current.get(id)
      const item = itemsRef.current.find(i => i.id === id)
      if (!file || item?.status !== 'error') return
      if (isAttachable(file)) void upload(id, file)
      else fail(id, UNSUPPORTED_MESSAGE)
    },
    [upload, fail]
  )

  /** Cancels the upload of `id` and frees its preview. */
  const discard = useCallback((id: string) => {
    uploads.current.get(id)?.abort()
    uploads.current.delete(id)
    const preview = previews.current.get(id)
    if (preview) URL.revokeObjectURL(preview)
    previews.current.delete(id)
    files.current.delete(id)
  }, [])

  const remove = useCallback(
    (id: string) => {
      discard(id)
      setItems(current => current.filter(item => item.id !== id))
    },
    [discard]
  )

  const clear = useCallback(() => {
    for (const id of [...files.current.keys()]) discard(id)
    setItems([])
  }, [discard])

  useEffect(
    () => () => {
      for (const id of [...files.current.keys()]) discard(id)
    },
    [discard]
  )

  // Indexing status, while any uploaded file is still being indexed.
  const indexingKeys = items
    .filter(isIndexing)
    .map(item => item.result!.objectKey)
    .slice(0, MAX_STATUS_KEYS)
    .join(',')
  useEffect(() => {
    if (!indexingKeys) return
    const query = indexingKeys.split(',').map(encodeURIComponent).join(',')
    const timer = setInterval(() => {
      client.json<StatusResponse>(`/api/files/status?keys=${query}`).then(
        ({ statuses }) =>
          setItems(current =>
            current.map(item => {
              const found = statuses.find(
                s => s.objectKey === item.result?.objectKey
              )
              return found
                ? {
                    ...item,
                    ingestStatus: found.status,
                    ingestError: found.ingestError ?? undefined
                  }
                : item
            })
          ),
        // The status only informs: a failed poll waits for the next one.
        () => {}
      )
    }, INGEST_POLL_MS)
    return () => clearInterval(timer)
  }, [indexingKeys, client])

  const parts = useCallback(
    () =>
      items.flatMap(({ result }) =>
        result
          ? [
              {
                url: result.url,
                filename: result.filename,
                mediaType: result.mediaType
              }
            ]
          : []
      ),
    [items]
  )

  return {
    items,
    add,
    remove,
    retry,
    ready: items.every(item => item.status === 'done'),
    parts,
    clear
  }
}
