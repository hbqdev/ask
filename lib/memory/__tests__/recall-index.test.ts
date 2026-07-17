import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/embeddings/transformers-embedding', () => ({
  embedTexts: vi.fn(async (t: string[]) =>
    t.map(() => new Array(1024).fill(0.1))
  ),
  getConfiguredModel: vi.fn(() => 'm')
}))
vi.mock('@/lib/db/recall-actions', () => ({
  deleteChunksForMessage: vi.fn(),
  insertChunks: vi.fn(),
  isRecallEnabled: vi.fn(async () => true)
}))

import * as db from '@/lib/db/recall-actions'
import { embedTexts } from '@/lib/embeddings/transformers-embedding'

import { indexMessage } from '../recall-index'

describe('indexMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(db.isRecallEnabled).mockResolvedValue(true)
  })

  it('deletes existing chunks before inserting (idempotent re-index)', async () => {
    const n = await indexMessage('u1', 'c1', 'm1', 'user', 'hello world')
    expect(db.deleteChunksForMessage).toHaveBeenCalledWith('u1', 'm1')
    expect(db.insertChunks).toHaveBeenCalled()
    expect(n).toBeGreaterThan(0)
  })

  it('is inert when recall is disabled', async () => {
    vi.mocked(db.isRecallEnabled).mockResolvedValue(false)
    expect(await indexMessage('u1', 'c1', 'm1', 'user', 'hello')).toBe(0)
    expect(db.insertChunks).not.toHaveBeenCalled()
  })

  it('skips loudly on an embedding dimension mismatch', async () => {
    vi.mocked(embedTexts).mockResolvedValueOnce([[0.1, 0.2]])
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await indexMessage('u1', 'c1', 'm1', 'user', 'hello')).toBe(0)
    expect(db.insertChunks).not.toHaveBeenCalled()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('never throws — a DB error resolves to 0', async () => {
    vi.mocked(db.insertChunks).mockRejectedValueOnce(new Error('db down'))
    await expect(indexMessage('u1', 'c1', 'm1', 'user', 'hello')).resolves.toBe(
      0
    )
  })

  it('returns 0 for empty text without touching the DB', async () => {
    expect(await indexMessage('u1', 'c1', 'm1', 'user', '   ')).toBe(0)
    expect(db.deleteChunksForMessage).not.toHaveBeenCalled()
  })
})
