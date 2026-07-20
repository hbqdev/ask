import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../transformers-embedding', async importOriginal => {
  const orig = await importOriginal<any>()
  return {
    ...orig,
    embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
    getConfiguredModel: () => 'mixedbread-ai/mxbai-embed-large-v1'
  }
})

import { isTextFamily, processFileForRAG } from '../upload-rag'

describe('fast-path extraction', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rag-'))
  })

  it('indexes markdown and returns true', async () => {
    const p = path.join(dir, 'notes.md')
    await writeFile(p, '# Title\n\n' + 'meaningful content here. '.repeat(20))
    expect(await processFileForRAG(p, 'text/markdown', 'notes.md')).toBe(true)
    const stored = JSON.parse(await readFile(p + '.chunks.json', 'utf-8'))
    expect(stored.chunks.length).toBeGreaterThan(0)
  })

  it('returns false for content under the 200-char floor', async () => {
    const p = path.join(dir, 'tiny.txt')
    await writeFile(p, 'too short')
    expect(await processFileForRAG(p, 'text/plain', 'tiny.txt')).toBe(false)
  })

  it('returns false for media types it cannot extract', async () => {
    const p = path.join(dir, 'song.mp3')
    await writeFile(p, 'not really audio')
    expect(await processFileForRAG(p, 'audio/mpeg', 'song.mp3')).toBe(false)
  })

  it('classifies text-family by media type and extension', () => {
    expect(isTextFamily('text/plain', 'a.txt')).toBe(true)
    expect(isTextFamily('application/octet-stream', 'main.rs')).toBe(true)
    expect(isTextFamily('application/pdf', 'doc.pdf')).toBe(true)
    expect(isTextFamily('video/mp4', 'clip.mp4')).toBe(false)
  })
})
