// @vitest-environment node
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
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

import { embedTexts } from '../transformers-embedding'
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

  // A 2 MB text file is the largest the upload route indexes inline, on the
  // web server's own event loop. Splitting, embedding and serialising it
  // must hand the loop back often enough that other requests keep flowing.
  it('indexes a 2 MB text file without holding the event loop for long', async () => {
    vi.mocked(embedTexts).mockClear()
    vi.mocked(embedTexts).mockImplementation(async (texts: string[]) =>
      texts.map(t => [t.length, 0])
    )
    let row = 0
    let csv = ''
    while (csv.length < 2 * 1024 * 1024) {
      csv += `${row},${'abcdefghijklmnopqrstuvwxyz'.repeat(3).slice(row % 26, (row % 26) + 60)}${row % 97}\n`
      row++
    }
    const p = path.join(dir, 'big.csv')
    await writeFile(p, csv)

    let last = performance.now()
    let maxGap = 0
    let running = true
    const tick = () => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
      if (running) setImmediate(tick)
    }
    setImmediate(tick)
    const ok = await processFileForRAG(p, 'text/csv', 'big.csv')
    running = false

    expect(ok).toBe(true)
    // Target is ~100 ms; the bound is loose for slow CI machines.
    expect(maxGap).toBeLessThan(250)

    // Embedded in bounded batches, and every vector stays with its chunk.
    const calls = vi.mocked(embedTexts).mock.calls
    expect(calls.length).toBeGreaterThan(1)
    for (const [texts] of calls) expect(texts.length).toBeLessThanOrEqual(64)
    const stored = JSON.parse(await readFile(p + '.chunks.json', 'utf-8'))
    expect(stored.filename).toBe('big.csv')
    expect(stored.chunks.length).toBe(
      calls.reduce((n, [texts]) => n + texts.length, 0)
    )
    for (const c of stored.chunks) expect(c.embedding[0]).toBe(c.content.length)
  }, 30_000)

  it('leaves no chunks file, partial or whole, when embedding fails midway', async () => {
    vi.mocked(embedTexts).mockClear()
    let calls = 0
    vi.mocked(embedTexts).mockImplementation(async (texts: string[]) => {
      if (++calls === 2) throw new Error('embedder down')
      return texts.map(() => [0.1, 0.2])
    })
    const p = path.join(dir, 'long.txt')
    await writeFile(p, 'A sentence of plain prose for the index. '.repeat(8000))

    await expect(
      processFileForRAG(p, 'text/plain', 'long.txt')
    ).rejects.toThrow('embedder down')
    expect(calls).toBe(2)
    expect((await readdir(dir)).sort()).toEqual(['long.txt'])
  })
})
