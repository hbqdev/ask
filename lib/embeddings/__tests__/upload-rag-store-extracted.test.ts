// @vitest-environment node
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../transformers-embedding', async importOriginal => {
  const orig = await importOriginal<any>()
  return {
    ...orig,
    embedTexts: vi.fn(),
    getConfiguredModel: () => 'mixedbread-ai/mxbai-embed-large-v1'
  }
})

import { embedTexts } from '../transformers-embedding'
import { storeExtractedChunks } from '../upload-rag'

// The worker path: chunks extracted out of process are embedded here. A big
// document can send 2000 of them, which one embedder call cannot finish
// within its timeout, so they go in the same bounded batches as the fast path.
describe('storeExtractedChunks', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'rag-store-'))
    vi.mocked(embedTexts).mockReset()
    vi.mocked(embedTexts).mockImplementation(async (texts: string[]) =>
      texts.map(t => [t.length, 0])
    )
  })

  it('embeds 150 chunks in 3 batches and stores every chunk with its own vector, in order', async () => {
    const p = path.join(dir, 'big.txt')
    await writeFile(p, 'x')
    const chunks = Array.from({ length: 150 }, (_, i) =>
      `chunk ${i} `.repeat((i % 7) + 1)
    )

    await storeExtractedChunks(p, 'big.txt', chunks)

    const calls = vi.mocked(embedTexts).mock.calls
    expect(calls.map(([texts]) => texts.length)).toEqual([64, 64, 22])
    const stored = JSON.parse(await readFile(p + '.chunks.json', 'utf-8'))
    expect(stored.model).toBe('mixedbread-ai/mxbai-embed-large-v1')
    expect(stored.filename).toBe('big.txt')
    expect(stored.chunks.map((c: any) => c.content)).toEqual(chunks)
    for (const c of stored.chunks) expect(c.embedding[0]).toBe(c.content.length)
    expect((await readdir(dir)).sort()).toEqual([
      'big.txt',
      'big.txt.chunks.json'
    ])
  })

  it('reports each finished batch, so the caller can keep the job claimed', async () => {
    const p = path.join(dir, 'a.txt')
    const onBatch = vi.fn()
    await storeExtractedChunks(
      p,
      'a.txt',
      Array.from({ length: 130 }, (_, i) => `c${i}`),
      onBatch
    )
    expect(onBatch).toHaveBeenCalledTimes(3)
  })

  it('still re-splits an oversized entry before embedding', async () => {
    const p = path.join(dir, 'a.txt')
    const huge = 'word '.repeat(2000) // 10 000 chars, over the 4000 cap
    await storeExtractedChunks(p, 'a.txt', ['short', huge])
    const stored = JSON.parse(await readFile(p + '.chunks.json', 'utf-8'))
    expect(stored.chunks.length).toBeGreaterThan(2)
    expect(stored.chunks[0].content).toBe('short')
  })

  it('leaves no chunks file, partial or whole, when a batch fails midway', async () => {
    let calls = 0
    vi.mocked(embedTexts).mockImplementation(async (texts: string[]) => {
      if (++calls === 2) throw new Error('This operation was aborted')
      return texts.map(() => [0.1, 0.2])
    })
    const p = path.join(dir, 'big.txt')
    await writeFile(p, 'x')

    await expect(
      storeExtractedChunks(
        p,
        'big.txt',
        Array.from({ length: 150 }, (_, i) => `c${i}`)
      )
    ).rejects.toThrow('This operation was aborted')
    expect(calls).toBe(2)
    expect(await readdir(dir)).toEqual(['big.txt'])
  })

  it('keeps an existing complete chunks file intact until the new one is whole', async () => {
    const p = path.join(dir, 'a.txt')
    await writeFile(p + '.chunks.json', '{"old":true}')
    vi.mocked(embedTexts).mockRejectedValue(new Error('embedder down'))

    await expect(storeExtractedChunks(p, 'a.txt', ['one'])).rejects.toThrow(
      'embedder down'
    )
    expect(await readFile(p + '.chunks.json', 'utf-8')).toBe('{"old":true}')
    expect(await readdir(dir)).toEqual(['a.txt.chunks.json'])
  })
})
