import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import * as dbActions from '@/lib/db/actions'

import { deleteNote, getNote, listNotes, saveNote } from '../notes'

vi.mock('@/lib/auth/get-current-user')
vi.mock('@/lib/db/actions')

const originalEnableAuth = process.env.ENABLE_AUTH

const note = {
  id: 'note-1',
  userId: 'user-1',
  chatId: 'chat-1',
  sourceMessageId: 'message-1',
  title: 'Saved answer',
  content: 'Saved answer content',
  createdAt: new Date('2026-06-17T00:00:00Z'),
  updatedAt: new Date('2026-06-17T00:00:00Z')
}

describe('Note Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ENABLE_AUTH = 'true'
    vi.mocked(getCurrentUserId).mockResolvedValue('user-1')
    vi.mocked(dbActions.createNote).mockResolvedValue(note)
    vi.mocked(dbActions.getChat).mockResolvedValue({
      id: 'chat-1',
      userId: 'user-1',
      visibility: 'private'
    } as any)
    vi.mocked(dbActions.getNotes).mockResolvedValue({
      notes: [note],
      nextCursor: null,
      hasMore: false
    })
    vi.mocked(dbActions.getNote).mockResolvedValue(note)
    vi.mocked(dbActions.deleteNote).mockResolvedValue({ success: true })
  })

  afterEach(() => {
    process.env.ENABLE_AUTH = originalEnableAuth
  })

  it('saves a markdown note for the current user', async () => {
    const result = await saveNote({
      content: '## **Saved answer**\n\nSaved answer content',
      chatId: 'chat-1',
      sourceMessageId: 'message-1'
    })

    expect(result).toEqual({ success: true, note })
    expect(dbActions.createNote).toHaveBeenCalledWith({
      userId: 'user-1',
      chatId: 'chat-1',
      sourceMessageId: 'message-1',
      title: 'Saved answer',
      content: '## **Saved answer**\n\nSaved answer content'
    })
  })

  it("checks the chat is the user's own", async () => {
    await saveNote({ content: 'Saved answer', chatId: 'chat-1' })

    expect(dbActions.getChat).toHaveBeenCalledWith('chat-1', 'user-1')
    expect(dbActions.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1' })
    )
  })

  it.each([
    [
      "another user's public chat",
      { id: 'chat-x', userId: 'user-2', visibility: 'public' }
    ],
    ['a chat that does not exist', null]
  ])('drops the chatId of %s and still saves', async (_label, chat) => {
    vi.mocked(dbActions.getChat).mockResolvedValue(chat as any)

    const result = await saveNote({ content: 'Saved answer', chatId: 'chat-x' })

    expect(result.success).toBe(true)
    expect(dbActions.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', chatId: null })
    )
  })

  it('does not look up a chat when none is given', async () => {
    await saveNote({ content: 'Saved answer' })

    expect(dbActions.getChat).not.toHaveBeenCalled()
    expect(dbActions.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: null })
    )
  })

  it('fails without saving when the chat lookup fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(dbActions.getChat).mockRejectedValue(new Error('db down'))

    const result = await saveNote({ content: 'Saved answer', chatId: 'chat-1' })

    expect(result).toEqual({ success: false, error: 'Failed to save note.' })
    expect(dbActions.createNote).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('rejects empty content', async () => {
    const result = await saveNote({ content: '   ' })

    expect(result).toEqual({ success: false, error: 'Nothing to save.' })
    expect(dbActions.createNote).not.toHaveBeenCalled()
  })

  it('rejects anonymous mode', async () => {
    process.env.ENABLE_AUTH = 'false'

    const result = await saveNote({ content: 'Saved answer' })

    expect(result).toEqual({
      success: false,
      error: 'Library is unavailable in anonymous mode.'
    })
    expect(dbActions.createNote).not.toHaveBeenCalled()
  })

  it('lists current user notes', async () => {
    const result = await listNotes()

    expect(result).toEqual({
      success: true,
      notes: [note],
      nextCursor: null,
      hasMore: false
    })
    expect(dbActions.getNotes).toHaveBeenCalledWith('user-1', {
      limit: 25,
      cursor: undefined
    })
  })

  it('lists current user notes from a cursor', async () => {
    const cursor = {
      updatedAt: '2026-06-17T00:00:00.000Z',
      id: 'note-1'
    }

    await listNotes({ limit: 10, cursor })

    expect(dbActions.getNotes).toHaveBeenCalledWith('user-1', {
      limit: 10,
      cursor
    })
  })

  it('loads a current user note', async () => {
    const result = await getNote('note-1')

    expect(result).toEqual({ success: true, note })
    expect(dbActions.getNote).toHaveBeenCalledWith('note-1', 'user-1')
  })

  it('deletes a current user note', async () => {
    const result = await deleteNote('note-1')

    expect(result).toEqual({ success: true })
    expect(dbActions.deleteNote).toHaveBeenCalledWith('note-1', 'user-1')
  })
})
