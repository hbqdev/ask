import { promises as fsPromises } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeUserUploads, userUploadsDir } from '../user-uploads'

const USER_ID = '550e8400-e29b-41d4-a716-446655440000'

describe('userUploadsDir', () => {
  const root = path.resolve('/srv/uploads')

  it.each([[USER_ID], ['anonymous-user'], ['lab-harness'], ['user_1']])(
    'resolves %s to a direct child of the uploads root',
    userId => {
      expect(userUploadsDir(userId, root)).toBe(path.join(root, userId))
    }
  )

  it.each([
    ['empty', ''],
    ['dot', '.'],
    ['dot-dot', '..'],
    ['a traversal', '../etc'],
    ['a nested traversal', 'a/../../etc'],
    ['a slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['an absolute path', '/etc'],
    ['a dotted name', 'user.name'],
    ['a NUL byte', 'a\0b'],
    ['whitespace', ' user']
  ])('rejects %s', (_label, userId) => {
    expect(userUploadsDir(userId, root)).toBeNull()
  })

  it('reads UPLOADS_DIR when no root is given', () => {
    vi.stubEnv('UPLOADS_DIR', '/data/ask-uploads')
    try {
      expect(userUploadsDir(USER_ID)).toBe(
        path.join(path.resolve('/data/ask-uploads'), USER_ID)
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('defaults to /app/uploads when UPLOADS_DIR is unset', () => {
    vi.stubEnv('UPLOADS_DIR', '')
    try {
      expect(userUploadsDir(USER_ID)).toBe(
        path.join(path.resolve('/app/uploads'), USER_ID)
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('removeUserUploads', () => {
  let uploadsDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(path.join(tmpdir(), 'ask-user-uploads-test-'))
    vi.stubEnv('UPLOADS_DIR', uploadsDir)
    await mkdir(path.join(uploadsDir, USER_ID, 'chats', 'c1'), {
      recursive: true
    })
    await writeFile(path.join(uploadsDir, USER_ID, 'chats', 'c1', 'a.pdf'), 'x')
    await writeFile(
      path.join(uploadsDir, USER_ID, 'chats', 'c1', 'a.pdf.chunks.json'),
      '[]'
    )
    await mkdir(path.join(uploadsDir, USER_ID, 'generated', 'none'), {
      recursive: true
    })
    await writeFile(
      path.join(uploadsDir, USER_ID, 'generated', 'none', 'img.webp'),
      'x'
    )
    await mkdir(path.join(uploadsDir, 'other-user', 'chats', 'c2'), {
      recursive: true
    })
    await writeFile(
      path.join(uploadsDir, 'other-user', 'chats', 'c2', 'b.pdf'),
      'y'
    )
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it("removes the user's whole tree and leaves other users' files", async () => {
    expect(await removeUserUploads(USER_ID)).toBe(true)

    expect(await readdir(uploadsDir)).toEqual(['other-user'])
  })

  it('succeeds when the user has no uploads folder', async () => {
    await rm(path.join(uploadsDir, USER_ID), { recursive: true })

    expect(await removeUserUploads(USER_ID)).toBe(true)
  })

  it('refuses a traversal id, logs it and touches nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await removeUserUploads('..')).toBe(false)
    expect(await removeUserUploads('../' + path.basename(uploadsDir))).toBe(
      false
    )

    expect((await readdir(uploadsDir)).sort()).toEqual([USER_ID, 'other-user'])
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('reports an fs failure as false instead of throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(fsPromises, 'rm').mockRejectedValueOnce(new Error('EBUSY'))

    expect(await removeUserUploads(USER_ID)).toBe(false)
    expect(error).toHaveBeenCalledTimes(1)
  })
})
