import { copyFile, readdir, unlink } from 'fs/promises'
import { basename, dirname, join } from 'path'

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

export async function writeBackup(envPath: string, now: Date): Promise<string> {
  const bak = `${envPath}.bak.${stamp(now)}`
  await copyFile(envPath, bak)
  return bak
}

export async function listBackups(
  envPath: string
): Promise<{ path: string; ts: string }[]> {
  const dir = dirname(envPath)
  const prefix = `${basename(envPath)}.bak.`
  const entries = await readdir(dir)
  return entries
    .filter(e => e.startsWith(prefix))
    .map(e => ({ path: join(dir, e), ts: e.slice(prefix.length) }))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
}

export async function pruneBackups(envPath: string, keep: number): Promise<void> {
  const list = await listBackups(envPath)
  for (const b of list.slice(keep)) await unlink(b.path)
}

export async function restoreBackup(
  envPath: string,
  backupPath: string
): Promise<void> {
  await copyFile(backupPath, envPath)
}
