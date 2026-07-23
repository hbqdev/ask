import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { createFileRecord } from '@/lib/db/file-actions'

// Persist a Replicate-generated image into the same local uploads store the
// upload route writes to (see app/api/upload/route.ts), so the LLM and the
// browser fetch it back over the existing /uploads/<objectKey> static route
// and it shows up in the user's library exactly like an uploaded file.
//
// The object key's SECOND path segment is fixed to `generated`, which the TTL
// sweep (see expireIdleUploads in lib/db/file-actions.ts) keys on to exempt
// these from idle-chat expiry — a generated image is a chat artifact, not a
// throwaway upload.

// image/<ext> content types → the extension we store the file under. Anything
// unrecognized (or a missing header) falls back to png.
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png'
}

function normalizeContentType(contentType: string | null): string {
  // Strip any `; charset=...` parameter and lowercase for a stable lookup.
  return (contentType ?? '').split(';')[0].trim().toLowerCase()
}

function extForContentType(contentType: string | null): string {
  return EXT_BY_CONTENT_TYPE[normalizeContentType(contentType)] ?? 'png'
}

// chatId flows from the client (same trust level as the upload route's
// x-chat-id header, which applies this identical guard). No-op on valid
// ids; neutralizes path metacharacters so the objectKey's segment layout
// — which the TTL sweep's split_part(object_key,'/',3) relies on — holds.
function sanitizeChatId(chatId: string): string {
  return chatId.replace(/[^a-z0-9\-_]/gi, '_')
}

export async function persistGeneratedImage(args: {
  sourceUrl: string // Replicate delivery URL (trusted: from Replicate's API response)
  userId: string
  chatId?: string
  modelPath: string
}): Promise<{ publicUrl: string; objectKey: string } | { error: string }> {
  const { sourceUrl, userId, chatId, modelPath } = args
  const uploadsDir = process.env.UPLOADS_DIR || '/app/uploads'

  // Fetch the rendered image. sourceUrl is trusted (it comes straight from
  // Replicate's prediction output), so no SSRF gating is needed here.
  let res: Response
  try {
    res = await fetch(sourceUrl)
  } catch (e) {
    return { error: `Failed to fetch generated image: ${(e as Error).message}` }
  }
  if (!res.ok) {
    return { error: `Failed to fetch generated image: HTTP ${res.status}` }
  }

  const contentType = res.headers.get('content-type')
  const ext = extForContentType(contentType)
  const mediaType = normalizeContentType(contentType) || 'image/png'

  // Layout mirrors app/api/upload/route.ts but with `generated` as the second
  // segment (TTL-exempt) and chatId as the third (what the TTL sweep reads via
  // split_part(object_key, '/', 3)).
  const objectKey = `${userId}/generated/${chatId ? sanitizeChatId(chatId) : 'none'}/${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`
  const absPath = path.join(uploadsDir, objectKey)

  let size: number
  try {
    const bytes = Buffer.from(await res.arrayBuffer())
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, bytes)
    size = bytes.length
  } catch (e) {
    // A partial write can leave a byte file behind; best-effort clean it up.
    await fs.unlink(absPath).catch(() => {})
    return { error: `Failed to store generated image: ${(e as Error).message}` }
  }

  const publicUrl = `/uploads/${objectKey}`
  // Model paths are `owner/name`; name the file after the model.
  const modelName = modelPath.split('/').pop() || modelPath
  const filename = `generated-${modelName}.${ext}`

  try {
    await createFileRecord({
      userId,
      // files.chat_id is a FK to chats.id; mirror the upload route and store
      // null (the chat association is carried by the objectKey path, and the
      // TTL sweep reads chatId from there, not from this column).
      chatId: null,
      filename,
      url: publicUrl,
      objectKey,
      mediaType,
      size,
      status: 'ready'
    })
  } catch (e) {
    // Don't leave an orphaned file on disk when the row never lands.
    await fs.unlink(absPath).catch(() => {})
    return {
      error: `Failed to record generated image: ${(e as Error).message}`
    }
  }

  return { publicUrl, objectKey }
}
