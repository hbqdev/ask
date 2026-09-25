import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { restoreBackup, writeBackup } from '../backups'
import { NEW_ENV_FILE_MODE, writeAskEnvAtomic } from '../env-io'

// Spy on FileHandle.chown (the writer chowns the open temp file, not a path),
// and optionally make stat() report a foreign owner, which an unprivileged
// test process could never actually create. Everything else is real fs.
const h = vi.hoisted(() => ({
  chownCalls: [] as { uid: number; gid: number; targetText: string | null }[],
  chownTarget: '' as string,
  failChown: false,
  fakeOwner: null as { uid: number; gid: number } | null
}))

vi.mock('fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('fs/promises')>()
  const stat: typeof real.stat = (async (
    ...args: Parameters<typeof real.stat>
  ) => {
    const st = await real.stat(...args)
    return h.fakeOwner ? Object.assign(st, h.fakeOwner) : st
  }) as typeof real.stat
  const open: typeof real.open = async (...args) => {
    const fh = await real.open(...args)
    const realChown = fh.chown.bind(fh)
    fh.chown = async (uid: number, gid: number) => {
      // Snapshot what the destination holds right now: if the rename had
      // already happened, this would be the NEW text.
      const targetText = h.chownTarget
        ? await real.readFile(h.chownTarget, 'utf8').catch(() => null)
        : null
      h.chownCalls.push({ uid, gid, targetText })
      if (h.failChown) {
        throw Object.assign(new Error('EPERM: operation not permitted'), {
          code: 'EPERM'
        })
      }
      // A foreign uid can't really be applied unprivileged; the call is
      // what's under test.
      if (h.fakeOwner) return
      return realChown(uid, gid)
    }
    return fh
  }
  return { ...real, default: { ...real, stat, open }, stat, open }
})

const modeOf = async (p: string) => (await stat(p)).mode & 0o777
const me = () => ({ uid: process.getuid!(), gid: process.getgid!() })

async function envFile(text: string, mode: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mm-io-'))
  const p = join(dir, '.env')
  await writeFile(p, text)
  await chmod(p, mode)
  return p
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  h.chownCalls = []
  h.chownTarget = ''
  h.failChown = false
  h.fakeOwner = null
  warn.mockRestore()
})

describe('writeAskEnvAtomic preserves the original owner and mode', () => {
  it('keeps a 0600 env file 0600 (was rewritten 0644 by the umask default)', async () => {
    const p = await envFile('A=1\n', 0o600)
    await writeAskEnvAtomic(p, 'A=2\n')
    expect(await readFile(p, 'utf8')).toBe('A=2\n')
    expect(await modeOf(p)).toBe(0o600)
    const st = await stat(p)
    expect({ uid: st.uid, gid: st.gid }).toEqual(me())
  })

  it('copies other modes exactly — neither clamped nor narrowed by the umask', async () => {
    for (const mode of [0o640, 0o664, 0o400]) {
      const p = await envFile('A=1\n', mode)
      await writeAskEnvAtomic(p, 'A=2\n')
      expect(await modeOf(p)).toBe(mode)
      expect(await readFile(p, 'utf8')).toBe('A=2\n')
    }
  })

  it('creates a missing env file 0600, never broader', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-io-'))
    const p = join(dir, '.env')
    await writeAskEnvAtomic(p, 'A=1\n')
    expect(NEW_ENV_FILE_MODE).toBe(0o600)
    expect(await modeOf(p)).toBe(0o600)
    expect(await readFile(p, 'utf8')).toBe('A=1\n')
    expect(h.chownCalls).toHaveLength(0) // no original owner to copy
  })

  it('chowns the temp file to the original uid/gid BEFORE the rename', async () => {
    const p = await envFile('A=1\n', 0o600)
    h.fakeOwner = { uid: 4242, gid: 4343 }
    h.chownTarget = p
    await writeAskEnvAtomic(p, 'A=2\n')
    expect(h.chownCalls).toEqual([
      { uid: 4242, gid: 4343, targetText: 'A=1\n' }
    ])
    expect(await readFile(p, 'utf8')).toBe('A=2\n')
  })

  it('a failed chown warns but still writes, keeping the mode', async () => {
    const p = await envFile('SECRET=hunter2\n', 0o600)
    h.failChown = true
    await writeAskEnvAtomic(p, 'SECRET=hunter3\n')
    expect(await readFile(p, 'utf8')).toBe('SECRET=hunter3\n')
    expect(await modeOf(p)).toBe(0o600)
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0][0])
    expect(msg).toMatch(/could not chown/)
    expect(msg).not.toMatch(/hunter/) // never log values
  })

  it('leaves no temp file behind, on success or on a failed rename', async () => {
    const p = await envFile('A=1\n', 0o600)
    await writeAskEnvAtomic(p, 'A=2\n')
    const dir = join(p, '..')
    expect(await readdir(dir)).toEqual(['.env'])

    // Renaming a file over a directory fails: the temp copy must be removed.
    const target = join(dir, 'sub')
    await mkdir(target)
    await expect(writeAskEnvAtomic(target, 'A=3\n')).rejects.toThrow()
    expect((await readdir(dir)).sort()).toEqual(['.env', 'sub'])
  })
})

describe('backups and restore', () => {
  it('writes a 0600 backup owned like the env file, even from a 0644 env', async () => {
    const p = await envFile('A=1\n', 0o644)
    h.fakeOwner = { uid: 4242, gid: 4343 }
    const bak = await writeBackup(p, new Date('2026-07-17T05:00:00.000Z'))
    expect(await modeOf(bak)).toBe(0o600)
    expect(await readFile(bak, 'utf8')).toBe('A=1\n')
    expect(h.chownCalls.map(c => [c.uid, c.gid])).toEqual([[4242, 4343]])
  })

  it('restore keeps the env file owner/mode and snapshots it 0600', async () => {
    const p = await envFile('A=1\n', 0o600)
    const bak = await writeBackup(p, new Date('2026-07-17T05:00:00.000Z'))
    await writeFile(p, 'A=2\n')
    await chmod(p, 0o640)
    const snap = await restoreBackup(
      p,
      bak,
      new Date('2026-07-17T06:00:00.000Z')
    )
    expect(await readFile(p, 'utf8')).toBe('A=1\n')
    expect(await modeOf(p)).toBe(0o640) // the env's mode, not the backup's
    expect(await modeOf(snap)).toBe(0o600)
    const st = await stat(p)
    expect({ uid: st.uid, gid: st.gid }).toEqual(me())
    // Every write (backup, snapshot, restore) chowned to the env's owner.
    for (const c of h.chownCalls)
      expect([c.uid, c.gid]).toEqual([me().uid, me().gid])
    expect(h.chownCalls).toHaveLength(3)
  })
})
