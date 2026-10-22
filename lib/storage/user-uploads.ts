import { promises as fs } from 'node:fs'
import path from 'node:path'

// A user's local upload tree: <UPLOADS_DIR>/<userId>/ holds their originals,
// the .chunks.json RAG sidecars and generated images (chats/ and generated/).
// UPLOADS_DIR is read at call time with the same default every upload module
// uses ('/app/uploads' in the container).
function uploadsRoot(): string {
  return process.env.UPLOADS_DIR || '/app/uploads'
}

// Supabase user ids are UUIDs; the anonymous id is a plain slug. Anything
// with a dot, slash, backslash or other punctuation can't be a user id.
const SAFE_USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/**
 * The absolute path of a user's upload tree, or null when the id is unsafe.
 * The result is always a direct child of the resolved uploads root.
 */
export function userUploadsDir(
  userId: string,
  root: string = uploadsRoot()
): string | null {
  if (!SAFE_USER_ID.test(userId)) return null
  const resolvedRoot = path.resolve(root)
  const dir = path.resolve(resolvedRoot, userId)
  if (path.dirname(dir) !== resolvedRoot) return null
  return dir
}

/**
 * Remove a user's whole upload tree. Never throws: an unsafe id or an fs
 * failure is logged and reported as false, so a caller can carry on (the
 * files are inert once the account is gone). A missing tree is success.
 */
export async function removeUserUploads(userId: string): Promise<boolean> {
  const dir = userUploadsDir(userId)
  if (!dir) {
    console.error(
      `Refusing to remove uploads for unsafe user id ${JSON.stringify(userId)}`
    )
    return false
  }
  try {
    await fs.rm(dir, { recursive: true, force: true })
    return true
  } catch (error) {
    console.error(`Failed to remove uploads for user ${userId}:`, error)
    return false
  }
}
