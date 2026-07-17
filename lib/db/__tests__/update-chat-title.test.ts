import { beforeEach, describe, expect, it, vi } from 'vitest'

// withOptionalRLS(null, cb) calls cb(db) directly (no transaction), so the db
// mock needs `update` itself — not just `transaction`. See lib/db/with-rls.ts.
vi.mock('@/lib/db', () => ({
  db: { transaction: vi.fn(), update: vi.fn(), execute: vi.fn() }
}))

import { db } from '@/lib/db'
import { CHAT_TITLE_MAX_LENGTH } from '@/lib/db/schema'

import { updateChatTitle } from '../actions'

/** Captures the values handed to .set() so we can assert on the stored title. */
function captureSet() {
  const set = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'c1' }])
    })
  })
  vi.mocked(db.update).mockReturnValue({ set } as any)
  // RLS path (userId given) runs the same callback against a tx.
  vi.mocked(db.transaction).mockImplementation(async (cb: any) => cb(db))
  return set
}

describe('updateChatTitle', () => {
  beforeEach(() => vi.resetAllMocks())

  it('caps a runaway title at CHAT_TITLE_MAX_LENGTH', async () => {
    // The prod bug this backstops: the title model answered the user's
    // question instead of titling it, and this path wrote the whole answer
    // verbatim — `chats.title` is unbounded `text`, so nothing else stopped
    // it. Four prod chats ended up with titles up to 4,832 chars.
    const set = captureSet()
    await updateChatTitle('c1', 'A'.repeat(5000))
    expect(set.mock.calls[0][0].title).toHaveLength(CHAT_TITLE_MAX_LENGTH)
  })

  it('caps on the RLS path too', async () => {
    const set = captureSet()
    await updateChatTitle('c1', 'A'.repeat(5000), 'user-1')
    expect(set.mock.calls[0][0].title).toHaveLength(CHAT_TITLE_MAX_LENGTH)
  })

  it('leaves a normal title untouched', async () => {
    const set = captureSet()
    await updateChatTitle('c1', 'Firecrawl Alternatives')
    expect(set).toHaveBeenCalledWith({ title: 'Firecrawl Alternatives' })
  })

  it('leaves a title exactly at the limit untouched', async () => {
    const set = captureSet()
    const exact = 'B'.repeat(CHAT_TITLE_MAX_LENGTH)
    await updateChatTitle('c1', exact)
    expect(set.mock.calls[0][0].title).toBe(exact)
  })
})
