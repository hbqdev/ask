import { readdir, readFile, unlink } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'

import { statAttrs, writeAskEnvAtomic, writeFileAtomic } from './env-io'

// Backups carry every secret in the env file: owner read/write only, whatever
// the env file's own mode is (a group/world-readable .env must not multiply
// into group/world-readable copies).
export const BACKUP_MODE = 0o600

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

// Exactly the suffix writeBackup() produces (ISO time with `:`/`.` → `-`).
// Hand-made siblings like `.env.bak.classifier-swap-20260903` deliberately do
// NOT match: they are neither listed, pruned, nor restorable from the UI.
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/

// Byte-exact copy of the env file, created 0600 and owned like the env file
// (so the host user who owns .env can still read/prune its backups). Written
// via the same atomic temp+rename path, so a backup is never half-written.
export async function writeBackup(envPath: string, now: Date): Promise<string> {
  const bak = `${envPath}.bak.${stamp(now)}`
  const data = await readFile(envPath)
  const src = await statAttrs(envPath)
  await writeFileAtomic(bak, data, {
    uid: src?.uid,
    gid: src?.gid,
    mode: BACKUP_MODE
  })
  return bak
}

export async function listBackups(
  envPath: string
): Promise<{ path: string; ts: string }[]> {
  const dir = dirname(envPath)
  const prefix = `${basename(envPath)}.bak.`
  const entries = await readdir(dir)
  return entries
    .filter(e => e.startsWith(prefix) && STAMP_RE.test(e.slice(prefix.length)))
    .map(e => ({ path: join(dir, e), ts: e.slice(prefix.length) }))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
}

export async function pruneBackups(
  envPath: string,
  keep: number
): Promise<void> {
  const list = await listBackups(envPath)
  for (const b of list.slice(keep)) await unlink(b.path)
}

// Only a backup this app wrote may be restored: same directory as the env
// file, `<env>.bak.<stamp>` name, and currently present in listBackups(). This
// blocks `../` traversal and arbitrary-file → .env copies via the API.
export async function resolveOwnBackup(
  envPath: string,
  backupPath: unknown
): Promise<string | null> {
  if (typeof backupPath !== 'string' || !backupPath) return null
  const abs = resolve(dirname(envPath), backupPath)
  if (dirname(abs) !== resolve(dirname(envPath))) return null
  const prefix = `${basename(envPath)}.bak.`
  const name = basename(abs)
  if (!name.startsWith(prefix) || !STAMP_RE.test(name.slice(prefix.length))) {
    return null
  }
  const known = await listBackups(envPath)
  return known.some(b => resolve(b.path) === abs) ? abs : null
}

// Restore a validated backup over the env file, snapshotting the current env
// first so a restore is itself undoable. Returns the snapshot path.
export async function restoreBackup(
  envPath: string,
  backupPath: string,
  now: Date = new Date()
): Promise<string> {
  const own = await resolveOwnBackup(envPath, backupPath)
  if (!own) throw new Error('Not a model-manager backup of this env file')
  let when = now
  // Never let the snapshot overwrite the very backup being restored.
  while (resolve(`${envPath}.bak.${stamp(when)}`) === own) {
    when = new Date(when.getTime() + 1)
  }
  const snapshot = await writeBackup(envPath, when)
  // Atomic, and keeps the CURRENT env file's owner/mode — copyFile would have
  // written in place and stamped the backup's mode onto .env.
  await writeAskEnvAtomic(envPath, await readFile(own))
  return snapshot
}
