import { randomUUID } from 'crypto'
import { open, readFile, rename, stat, unlink } from 'fs/promises'

// Mode for an env file (or backup) with no original to copy from. These files
// hold secrets, so never broader than owner read/write.
export const NEW_ENV_FILE_MODE = 0o600

export interface FileAttrs {
  uid: number
  gid: number
  /** Permission bits only (st_mode & 0o7777). */
  mode: number
}

/** Target metadata for a write: ownership is optional (omit = leave as-is). */
export type WriteAttrs = Pick<FileAttrs, 'mode'> &
  Partial<Pick<FileAttrs, 'uid' | 'gid'>>

export async function readAskEnv(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

/** Owner and permission bits of `path`, or null when it does not exist. */
export async function statAttrs(path: string): Promise<FileAttrs | null> {
  try {
    const st = await stat(path)
    return { uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/**
 * Atomically replace `path` with `data` (temp file in the same directory +
 * rename), giving the new file exactly `attrs`.
 *
 * This app runs as root in its container. A plain writeFile + rename therefore
 * produced a root-owned file with the umask default mode: prod's
 * `nightfury:nightfury 0600` .env came back `root:root 0644`, world-readable
 * secrets. So the temp file is created exclusively (O_EXCL, never following
 * whatever sits at that name) at no broader than 0600, then chowned and
 * chmodded on the open descriptor (no path race) BEFORE the rename, so the
 * file at `path` never has the wrong owner or mode.
 *
 * A failed chown (not root, e.g. dev) is a warning, not a failure: the mode is
 * still applied and the write goes ahead.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  attrs: WriteAttrs
): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`
  const fh = await open(tmp, 'wx', attrs.mode & NEW_ENV_FILE_MODE)
  let renamed = false
  try {
    try {
      await fh.writeFile(data)
      if (attrs.uid !== undefined && attrs.gid !== undefined) {
        try {
          await fh.chown(attrs.uid, attrs.gid)
        } catch (e) {
          console.warn(
            `[env-io] could not chown ${path} to ${attrs.uid}:${attrs.gid} ` +
              `(${(e as NodeJS.ErrnoException).code ?? String(e)}); ` +
              `keeping mode ${attrs.mode.toString(8)}, owner is this process`
          )
        }
      }
      // Explicit, and after chown (which may clear set-id bits): the create
      // mode above is capped at 0600 and further narrowed by the umask.
      await fh.chmod(attrs.mode)
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, path)
    renamed = true
  } finally {
    // Never leave a stray copy of the secrets behind on a failed write.
    if (!renamed) await unlink(tmp).catch(() => {})
  }
}

/**
 * Atomically rewrite an env file, preserving the ORIGINAL file's uid, gid and
 * mode. A file that does not exist yet is created 0600, owned by this process.
 */
export async function writeAskEnvAtomic(
  path: string,
  data: string | Uint8Array
): Promise<void> {
  const orig = await statAttrs(path)
  await writeFileAtomic(path, data, orig ?? { mode: NEW_ENV_FILE_MODE })
}
