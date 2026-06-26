'use server'

import { and, asc, desc, eq, gt, ilike, inArray, lt, or, sql } from 'drizzle-orm'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import type { UIMessage } from '@/lib/types/ai'
import type { PersistableUIMessage } from '@/lib/types/message-persistence'
import {
  buildUIMessageFromDB,
  mapUIMessagePartsToDBParts,
  mapUIMessageToDBMessage
} from '@/lib/utils/message-mapping'
import { perfLog, perfTime } from '@/lib/utils/perf-logging'
import { incrementDbOperationCount } from '@/lib/utils/perf-tracking'

import type { Chat, Message, NewNote, Note } from './schema'
import {
  chats,
  feedback,
  generateId,
  libraryFiles,
  messages,
  notes,
  parts
} from './schema'
import { withOptionalRLS, withRLS } from './with-rls'
import { db } from '.'

/**
 * Create a new chat
 */
export async function createChat({
  id = generateId(),
  title,
  userId,
  visibility = 'private'
}: {
  id?: string
  title: string
  userId: string
  visibility?: 'public' | 'private'
}): Promise<Chat> {
  return withRLS(userId, async tx => {
    const [chat] = await tx
      .insert(chats)
      .values({
        id,
        title,
        userId,
        visibility,
        // Stamp lastViewedAt at creation so new chats land at the top
        // of the sidebar (Perplexity-style).
        lastViewedAt: new Date()
      })
      .returning()

    return chat
  })
}

/**
 * Get chat by ID with permission check
 */
export async function getChat(
  chatId: string,
  userId?: string
): Promise<Chat | null> {
  // For public chats or when no userId, use regular db connection
  // For private chats with userId, use RLS
  return withOptionalRLS(userId || null, async tx => {
    const [chat] = await tx
      .select()
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1)

    if (!chat) {
      return null
    }

    // Additional permission check for backward compatibility
    if (chat.visibility === 'public') {
      return chat
    }

    if (chat.visibility === 'private' && userId && chat.userId === userId) {
      return chat
    }

    return null
  })
}

/**
 * Upsert a message with its parts
 * Note: This function should be called with appropriate userId context
 */
export async function upsertMessage(
  message: PersistableUIMessage & { chatId: string },
  userId?: string
): Promise<Message> {
  const count = incrementDbOperationCount()
  perfLog(`DB - upsertMessage called - count: ${count}`)

  // Use RLS if userId is provided, otherwise use regular db
  const executeFn = userId
    ? (callback: (tx: any) => Promise<Message>) => withRLS(userId, callback)
    : (callback: (tx: any) => Promise<Message>) => db.transaction(callback)

  const result = await executeFn(async tx => {
    // 1. Insert or update the message
    const messageData = mapUIMessageToDBMessage(message)
    const [dbMessage] = await tx
      .insert(messages)
      .values(messageData)
      .onConflictDoUpdate({
        target: messages.id,
        set: { role: messageData.role }
      })
      .returning()

    // 2. Delete existing parts
    await tx.delete(parts).where(eq(parts.messageId, message.id))

    // 3. Insert new parts
    if (message.parts && message.parts.length > 0) {
      const dbParts = mapUIMessagePartsToDBParts(message.parts, message.id)
      if (dbParts.length > 0) {
        await tx.insert(parts).values(dbParts)
      }
    }

    return dbMessage
  })

  return result
}

/**
 * Load chat messages with parts
 * Note: Caller should verify chat access permissions before calling this
 */
export async function loadChat(
  chatId: string,
  userId?: string
): Promise<UIMessage[]> {
  return withOptionalRLS(userId || null, async tx => {
    // Use Drizzle's query API with relations
    const result = await tx.query.messages.findMany({
      where: eq(messages.chatId, chatId),
      with: {
        parts: {
          orderBy: [asc(parts.order)]
        }
      },
      orderBy: [asc(messages.createdAt)]
    })

    // Convert to UI format
    return result.map(msg => buildUIMessageFromDB(msg, msg.parts))
  })
}

/**
 * Load chat with messages in a single query (optimized)
 */
export async function loadChatWithMessages(
  chatId: string,
  userId?: string
): Promise<(Chat & { messages: UIMessage[] }) | null> {
  const count = incrementDbOperationCount()
  perfLog(`DB - loadChatWithMessages called - count: ${count}`)

  return withOptionalRLS(userId || null, async tx => {
    // Get chat and messages in parallel
    const [chatResult, messagesResult] = await Promise.all([
      tx.select().from(chats).where(eq(chats.id, chatId)).limit(1),
      tx.query.messages.findMany({
        where: eq(messages.chatId, chatId),
        with: {
          parts: {
            orderBy: [asc(parts.order)]
          }
        },
        orderBy: [asc(messages.createdAt)]
      })
    ])

    const chat = chatResult[0]
    if (!chat) {
      return null
    }

    // Permission check for backward compatibility
    if (chat.visibility === 'private' && (!userId || chat.userId !== userId)) {
      return null
    }

    // Build result
    const uiMessages = messagesResult.map(msg =>
      buildUIMessageFromDB(msg, msg.parts)
    )
    return { ...chat, messages: uiMessages }
  })
}

/**
 * Delete messages after a specific message
 */
export async function deleteMessagesAfter(
  chatId: string,
  messageId: string,
  userId?: string
): Promise<{ count: number }> {
  return withOptionalRLS(userId || null, async tx => {
    // Get the message's timestamp
    const [targetMessage] = await tx
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)

    if (!targetMessage) {
      return { count: 0 }
    }

    // Find messages to delete
    const messagesToDelete = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.chatId, chatId),
          gt(messages.createdAt, targetMessage.createdAt)
        )
      )

    const messageIds = messagesToDelete.map(m => m.id)

    if (messageIds.length > 0) {
      // Delete messages (parts will be cascade deleted)
      await tx.delete(messages).where(inArray(messages.id, messageIds))
    }

    return { count: messageIds.length }
  })
}

/**
 * Delete messages from a specific index
 */
export async function deleteMessagesFromIndex(
  chatId: string,
  messageId: string,
  userId?: string
): Promise<{ count: number }> {
  return withOptionalRLS(userId || null, async tx => {
    // Get all messages for the chat
    const allMessages = await tx
      .select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(asc(messages.createdAt))

    // Find the index of the target message
    const messageIndex = allMessages.findIndex(m => m.id === messageId)

    if (messageIndex === -1) {
      return { count: 0 }
    }

    // Get messages to delete (from index onwards)
    const messagesToDelete = allMessages.slice(messageIndex)
    const messageIds = messagesToDelete.map(m => m.id)

    if (messageIds.length > 0) {
      await tx.delete(messages).where(inArray(messages.id, messageIds))
    }

    return { count: messageIds.length }
  })
}

/**
 * Get all chats for a user
 */
export async function getChats(userId: string): Promise<Chat[]> {
  return withRLS(userId, async tx => {
    return tx
      .select()
      .from(chats)
      .where(eq(chats.userId, userId))
      .orderBy(sql`${chats.lastViewedAt} DESC NULLS LAST`, desc(chats.createdAt))
  })
}

/**
 * Get chats with pagination
 */
export async function getChatsPage(
  userId: string,
  limit = 20,
  offset = 0
): Promise<{ chats: Chat[]; nextOffset: number | null }> {
  try {
    return withRLS(userId, async tx => {
      const results = await tx
        .select()
        .from(chats)
        .where(eq(chats.userId, userId))
        .orderBy(sql`${chats.lastViewedAt} DESC NULLS LAST`, desc(chats.createdAt))
        .limit(limit)
        .offset(offset)

      const nextOffset = results.length === limit ? offset + limit : null

      return {
        chats: results,
        nextOffset
      }
    })
  } catch (error) {
    console.error('Error fetching chat page:', error)
    return { chats: [], nextOffset: null }
  }
}

/**
 * Delete a chat
 */
export async function deleteChat(
  chatId: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    return withRLS(userId, async tx => {
      // Verify ownership
      const [chat] = await tx
        .select()
        .from(chats)
        .where(eq(chats.id, chatId))
        .limit(1)

      if (!chat || chat.userId !== userId) {
        return { success: false, error: 'Unauthorized' }
      }

      // Delete the chat (messages and parts will cascade)
      await tx.delete(chats).where(eq(chats.id, chatId))

      return { success: true }
    })
  } catch (error) {
    console.error('Error deleting chat:', error)
    return { success: false, error: 'Failed to delete chat' }
  }
}

/**
 * Delete all chats for a user.
 * Messages and parts are removed by database cascades.
 */
export async function deleteUserChats(
  userId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    return withRLS(userId, async tx => {
      await tx.delete(chats).where(eq(chats.userId, userId))
      return { success: true }
    })
  } catch (error) {
    console.error('Error deleting user chats:', error)
    return { success: false, error: 'Failed to delete user chats' }
  }
}

export async function createNote(
  note: Omit<NewNote, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Note> {
  return withRLS(note.userId, async tx => {
    const [createdNote] = await tx.insert(notes).values(note).returning()

    return createdNote
  })
}

export type NotesPageCursor = {
  updatedAt: string
  id: string
}

export async function getNotes(
  userId: string,
  {
    limit = 25,
    cursor
  }: {
    limit?: number
    cursor?: NotesPageCursor
  } = {}
): Promise<{
  notes: Note[]
  nextCursor: NotesPageCursor | null
  hasMore: boolean
}> {
  return withRLS(userId, async tx => {
    const cursorDate = cursor ? new Date(cursor.updatedAt) : null
    const pageLimit = Math.max(1, Math.min(limit, 50))
    const results = await tx
      .select()
      .from(notes)
      .where(
        and(
          eq(notes.userId, userId),
          cursor && cursorDate && !Number.isNaN(cursorDate.getTime())
            ? or(
                lt(notes.updatedAt, cursorDate),
                and(eq(notes.updatedAt, cursorDate), lt(notes.id, cursor.id))
              )
            : undefined
        )
      )
      .orderBy(desc(notes.updatedAt), desc(notes.id))
      .limit(pageLimit + 1)

    const pageNotes = results.slice(0, pageLimit)
    const lastNote = pageNotes[pageNotes.length - 1]

    return {
      notes: pageNotes,
      nextCursor:
        results.length > pageLimit && lastNote
          ? {
              updatedAt: lastNote.updatedAt.toISOString(),
              id: lastNote.id
            }
          : null,
      hasMore: results.length > pageLimit
    }
  })
}

export async function getNote(
  noteId: string,
  userId: string
): Promise<Note | null> {
  return withRLS(userId, async tx => {
    const [note] = await tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
      .limit(1)

    return note ?? null
  })
}

export async function deleteNote(
  noteId: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    return withRLS(userId, async tx => {
      const [deletedNote] = await tx
        .delete(notes)
        .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
        .returning({ id: notes.id })

      if (!deletedNote) {
        return { success: false, error: 'Note not found' }
      }

      return { success: true }
    })
  } catch (error) {
    console.error('Error deleting note:', error)
    return { success: false, error: 'Failed to delete note' }
  }
}

export async function deleteUserNotes(
  userId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    return withRLS(userId, async tx => {
      await tx.delete(notes).where(eq(notes.userId, userId))
      return { success: true }
    })
  } catch (error) {
    console.error('Error deleting user notes:', error)
    return { success: false, error: 'Failed to delete user notes' }
  }
}

/**
 * Bump the `last_viewed_at` timestamp on a chat so the sidebar can
 * surface recently-viewed threads at the top (Perplexity-style).
 *
 * Safe to call on every chat page load. Fire-and-forget from the caller.
 * Returns silently if the chat doesn't exist, isn't owned by the user,
 * or there's no signed-in user (guest mode).
 */
export async function touchChat(chatId: string): Promise<void> {
  try {
    const userId = await getCurrentUserId()
    if (!userId) return // Guest — no DB write needed
    await withRLS(userId, async tx => {
      await tx
        .update(chats)
        .set({ lastViewedAt: new Date() })
        .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    })
  } catch (error) {
    // Touch failures should never break the page render.
    console.warn('touchChat failed (non-fatal):', error)
  }
}

export type ChatSearchResult = {
  chatId: string
  chatTitle: string
  snippet: string      // ~150 chars of context around the match
  role: string         // 'user' | 'assistant'
  lastViewedAt: Date | null
}

/**
 * Full-text search across chat titles and message text.
 * Returns up to 20 matching chats, most-recently-viewed first.
 */
export async function searchUserChats(
  userId: string,
  query: string,
  limit = 20
): Promise<ChatSearchResult[]> {
  const term = `%${query}%`

  return withRLS(userId, async tx => {
    // Search across titles and message text parts, deduplicated per chat.
    // ILIKE is case-insensitive and sufficient for personal-scale history.
    const rows = await tx
      .selectDistinctOn([chats.id], {
        chatId: chats.id,
        chatTitle: chats.title,
        snippet: parts.text_text,
        role: messages.role,
        lastViewedAt: chats.lastViewedAt
      })
      .from(chats)
      .leftJoin(messages, eq(messages.chatId, chats.id))
      .leftJoin(parts, and(eq(parts.messageId, messages.id), eq(parts.type, 'text')))
      .where(
        and(
          eq(chats.userId, userId),
          or(
            ilike(chats.title, term),
            ilike(parts.text_text, term)
          )
        )
      )
      .orderBy(chats.id, sql`${chats.lastViewedAt} DESC NULLS LAST`)
      .limit(limit)

    // Trim snippet to ~150 chars centred on the match
    return rows.map(row => ({
      chatId: row.chatId,
      chatTitle: row.chatTitle,
      snippet: extractSnippet(row.snippet ?? row.chatTitle, query),
      role: row.role ?? 'user',
      lastViewedAt: row.lastViewedAt
    }))
  })
}

function extractSnippet(text: string, query: string): string {
  const MAX = 150
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text.slice(0, MAX)
  const start = Math.max(0, idx - 60)
  const end = Math.min(text.length, start + MAX)
  const snippet = text.slice(start, end)
  return (start > 0 ? '…' : '') + snippet + (end < text.length ? '…' : '')
}

export async function deleteUserLibraryFiles(
  userId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    return withRLS(userId, async tx => {
      await tx.delete(libraryFiles).where(eq(libraryFiles.userId, userId))
      return { success: true }
    })
  } catch (error) {
    console.error('Error deleting user library files:', error)
    return { success: false, error: 'Failed to delete user files' }
  }
}

/**
 * Remove account linkage from feedback while retaining the feedback content.
 */
export async function anonymizeUserFeedback(
  userId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    return withRLS(userId, async tx => {
      await tx
        .update(feedback)
        .set({ userId: null })
        .where(eq(feedback.userId, userId))

      return { success: true }
    })
  } catch (error) {
    console.error('Error anonymizing user feedback:', error)
    return { success: false, error: 'Failed to anonymize user feedback' }
  }
}

/**
 * Update chat visibility
 */
export async function updateChatVisibility(
  chatId: string,
  userId: string,
  visibility: 'public' | 'private'
): Promise<Chat | null> {
  return withRLS(userId, async tx => {
    const chat = await getChat(chatId, userId)
    if (!chat || chat.userId !== userId) {
      return null
    }

    const [updatedChat] = await tx
      .update(chats)
      .set({ visibility })
      .where(eq(chats.id, chatId))
      .returning()

    return updatedChat
  })
}

/**
 * Update chat title
 */
export async function updateChatTitle(
  chatId: string,
  title: string,
  userId?: string
): Promise<Chat | null> {
  return withOptionalRLS(userId || null, async tx => {
    const [updatedChat] = await tx
      .update(chats)
      .set({ title })
      .where(eq(chats.id, chatId))
      .returning()

    return updatedChat || null
  })
}

/**
 * Create a chat with the first message in a single transaction
 * Optimized for new chat creation
 */
export async function createChatWithFirstMessageTransaction({
  chatId,
  chatTitle,
  userId,
  message
}: {
  chatId: string
  chatTitle: string
  userId: string
  message: PersistableUIMessage
}): Promise<{ chat: Chat; message: Message }> {
  perfLog(`DB - createChatWithFirstMessageTransaction start`)
  const dbStart = performance.now()
  return await withRLS(userId, async tx => {
    // 1. Create chat
    const [chat] = await tx
      .insert(chats)
      .values({
        id: chatId,
        title: chatTitle.substring(0, 255),
        userId,
        visibility: 'private',
        createdAt: new Date(),
        lastViewedAt: new Date()
      })
      .returning()

    // 2. Save message
    const dbMessage = mapUIMessageToDBMessage({ ...message, chatId })
    const [savedMessage] = await tx
      .insert(messages)
      .values(dbMessage)
      .returning()

    // 3. Save parts if they exist
    if (message.parts && message.parts.length > 0) {
      const partsData = mapUIMessagePartsToDBParts(
        message.parts,
        savedMessage.id
      )
      if (partsData.length > 0) {
        await tx.insert(parts).values(partsData)
      }
    }

    perfTime('DB - createChatWithFirstMessageTransaction completed', dbStart)
    return { chat, message: savedMessage }
  })
}
