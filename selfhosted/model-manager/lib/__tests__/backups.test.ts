import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { listBackups, pruneBackups, restoreBackup, writeBackup } from '../backups'

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
  it('restores a backup over the env file', async () => {
    const p = await tmpEnv()
    const bak = await writeBackup(p, new Date('2026-07-17T05:00:00.000Z'))
    await writeFile(p, 'A=2\n')
    await restoreBackup(p, bak)
    expect(await readFile(p, 'utf8')).toBe('A=1\n')
  })
})
