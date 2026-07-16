import { UIMessage } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pins the WIRING that closes the C-1 privacy leak: `data-recall` parts name
// the user's OTHER private chats by title+id, and `public_chat_parts_readable`
// exposes every part of a shared chat to anonymous visitors. The fix is the
// single `stripRecallFromMessage(...)` call in persist-stream-results.ts —
// strip-recall-from-message.test.ts covers the helper in isolation, but
// nothing pinned the one line that actually wires it into the persistence
// path. If a future refactor drops that call (or reorders things so it no
// longer runs before upsertMessage), this test must fail.
vi.mock('@/lib/actions/chat')
vi.mock('@/lib/db/actions')

import { createChatWithFirstMessage, upsertMessage } from '@/lib/actions/chat'

import { persistStreamResults } from '../persist-stream-results'

describe('persistStreamResults', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(upsertMessage).mockResolvedValue(undefined as any)
    vi.mocked(createChatWithFirstMessage).mockResolvedValue(undefined as any)
  })

  it('strips data-recall parts before handing the message to upsertMessage', async () => {
    const responseMessage = {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Here is your answer.' },
        {
          type: 'data-recall',
          id: 'recall',
          data: { chats: [{ chatId: 'private-chat-a', title: 'Severance' }] }
        }
      ]
    } as unknown as UIMessage

    await persistStreamResults(responseMessage, 'chat-1', 'user-1')

    expect(upsertMessage).toHaveBeenCalledTimes(1)
    const persisted = vi.mocked(upsertMessage).mock.calls[0][1] as UIMessage

    expect(persisted.parts.some(p => p.type === 'text')).toBe(true)
    expect(persisted.parts.some(p => p.type === 'data-recall')).toBe(false)
  })
})
