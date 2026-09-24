import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  listBackups,
  pruneBackups,
  resolveOwnBackup,
  restoreBackup,
  writeBackup
} from '../backups'

async function tmpEnv(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mm-'))
  const p = join(dir, '.env')
  await writeFile(p, 'A=1\n')
  return p
}

describe('backups', () => {
  it('writes a timestamped backup with the file contents', async () => {
    const p = await tmpEnv()
    const bak = await writeBackup(p, new Date('2026-07-17T05:00:00.000Z'))
    expect(bak).toBe(`${p}.bak.2026-07-17T05-00-00-000Z`)
    expect(await readFile(bak, 'utf8')).toBe('A=1\n')
  })
  it('lists newest first and prunes to keep', async () => {
    const p = await tmpEnv()
    await writeBackup(p, new Date('2026-07-17T05:00:00.000Z'))
    await writeBackup(p, new Date('2026-07-17T06:00:00.000Z'))
    await writeBackup(p, new Date('2026-07-17T07:00:00.000Z'))
    let list = await listBackups(p)
    expect(list).toHaveLength(3)
    expect(list[0].ts > list[1].ts).toBe(true)
    await pruneBackups(p, 2)
    list = await listBackups(p)
    expect(list).toHaveLength(2)
    expect(list[0].ts).toContain('07-00-00') // kept newest two
  })
  it('restores a backup over the env file, snapshotting the current env first', async () => {
    const p = await tmpEnv()
    const bak = await writeBackup(p, new Date('2026-07-17T05:00:00.000Z'))
    await writeFile(p, 'A=2\n')
    const snap = await restoreBackup(
      p,
      bak,
      new Date('2026-07-17T06:00:00.000Z')
    )
    expect(await readFile(p, 'utf8')).toBe('A=1\n')
    expect(snap).toBe(`${p}.bak.2026-07-17T06-00-00-000Z`)
    expect(await readFile(snap, 'utf8')).toBe('A=2\n')
  })
  it('never lets the snapshot overwrite the backup being restored', async () => {
    const p = await tmpEnv()
    const at = new Date('2026-07-17T05:00:00.000Z')
    const bak = await writeBackup(p, at)
    await writeFile(p, 'A=2\n')
    const snap = await restoreBackup(p, bak, at)
    expect(snap).not.toBe(bak)
    expect(await readFile(p, 'utf8')).toBe('A=1\n')
    expect(await readFile(snap, 'utf8')).toBe('A=2\n')
  })
  it('refuses to restore anything that is not an app-made backup', async () => {
    const p = await tmpEnv()
    const dir = dirname(p)
    const outside = join(await mkdtemp(join(tmpdir(), 'mm-x-')), 'evil')
    await writeFile(outside, 'EVIL=1\n')
    const manual = `${p}.bak.classifier-swap-20260903`
    await writeFile(manual, 'M=1\n')
    const bak = await writeBackup(p, new Date('2026-07-17T05:00:00.000Z'))
    for (const bad of [
      outside,
      manual,
      '/etc/passwd',
      `${dir}/../${basename(dir)}/.env.bak.2026-07-17T09-00-00-000Z`, // absent
      `${p}.bak.2026-07-17T05-00-00-000Z/../../etc/passwd`,
      '',
      42
    ]) {
      expect(await resolveOwnBackup(p, bad)).toBeNull()
    }
    await expect(restoreBackup(p, outside)).rejects.toThrow()
    expect(await readFile(p, 'utf8')).toBe('A=1\n')
    // A relative `../x/.env.bak.<stamp>` that resolves back to a real backup
    // is fine; the canonical absolute path is returned.
    expect(
      await resolveOwnBackup(p, `../${basename(dir)}/${basename(bak)}`)
    ).toBe(bak)
  })
  it('lists and prunes only app-made backups (manual siblings are left alone)', async () => {
    const p = await tmpEnv()
    const manual = `${p}.bak.classifier-swap-20260903`
    await writeFile(manual, 'M=1\n')
    await writeBackup(p, new Date('2026-07-17T05:00:00.000Z'))
    expect((await listBackups(p)).map(b => b.path)).not.toContain(manual)
    await pruneBackups(p, 0)
    expect(await readFile(manual, 'utf8')).toBe('M=1\n')
  })
})
