import { NextRequest } from 'next/server'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// route.ts reads process.env.UPLOADS_DIR into a module-level const, so the env
// var must be set *before* the module is first evaluated — hence the dynamic
// import inside beforeAll (mirrors app/api/upload/__tests__/route.test.ts).
let uploadsDir: string
let GET: typeof import('../route').GET

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const WEBP_BYTES = Buffer.from('RIFF....WEBPVP8 ', 'ascii')

beforeAll(async () => {
  uploadsDir = await mkdtemp(path.join(tmpdir(), 'ask-uploads-get-test-'))
  process.env.UPLOADS_DIR = uploadsDir

  // <userId>/chats/<chatId>/<file> — a user upload
  await mkdir(path.join(uploadsDir, 'u1', 'chats', 'c1'), { recursive: true })
  await writeFile(
    path.join(uploadsDir, 'u1', 'chats', 'c1', 'pic.png'),
    PNG_BYTES
  )

  // <userId>/generated/<chatId>/<file> — an image-generation output (webp)
  await mkdir(path.join(uploadsDir, 'u1', 'generated', 'c1'), {
    recursive: true
  })
  await writeFile(
    path.join(uploadsDir, 'u1', 'generated', 'c1', 'img.webp'),
    WEBP_BYTES
  )
  ;({ GET } = await import('../route'))
})

afterAll(async () => {
  await rm(uploadsDir, { recursive: true, force: true })
})

function call(segments: string[]) {
  const req = new NextRequest(
    'http://localhost:3000/uploads/' + segments.join('/')
  )
  return GET(req, { params: Promise.resolve({ path: segments }) })
}

describe('GET /uploads/[...path]', () => {
  it('serves a user upload under the chats/ layout (200 with bytes)', async () => {
    const res = await call(['u1', 'chats', 'c1', 'pic.png'])

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.equals(PNG_BYTES)).toBe(true)
  })

  it('serves an image-generation output under the generated/ layout (200 with bytes, webp)', async () => {
    const res = await call(['u1', 'generated', 'c1', 'img.webp'])

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/webp')
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.equals(WEBP_BYTES)).toBe(true)
  })

  it('404s an unknown second segment', async () => {
    const res = await call(['u1', 'other', 'c1', 'pic.png'])
    expect(res.status).toBe(404)
  })

  it('404s a path-traversal attempt that escapes UPLOADS_DIR', async () => {
    const res = await call(['u1', 'chats', '..', '..', '..', 'etc', 'passwd'])
    expect(res.status).toBe(404)
  })
})
