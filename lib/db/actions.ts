'use server'

import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  lt,
  or,
  sql
} from 'drizzle-orm'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import type { UIMessage } from '@/lib/types/ai'
import type { PersistableUIMessage } from '@/lib/types/message-persistence'
import type { SearchMode } from '@/lib/types/search'
import {
  buildUIMessageFromDB,
  mapUIMessagePartsToDBParts,
  mapUIMessageToDBMessage
} from '@/lib/utils/message-mapping'
import { perfLog, perfTime } from '@/lib/utils/perf-logging'
import { incrementDbOperationCount } from '@/lib/utils/perf-tracking'

import type { Chat, Message, NewNote, Note } from './schema'
import {
  CHAT_TITLE_MAX_LENGTH,
  chats,
  conversationChunks,
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

    // 2b. Delete stale conversation-recall chunks for this message. The
    // message's text is about to change (or be reinserted verbatim) — any
    // existing chunks were derived from the OLD text, so they are stale by
    // definition. The normal path self-heals (onFinish re-runs indexMessage
    // for the same id, which itself deletes-then-reinserts), but if recall
    // was off or embedding failed during the turn that produced this edit,
    // nothing else would ever clear these out: messagesWithoutChunks's
    // `NOT EXISTS` check never re-selects a message that already has
    // chunks, so Rebuild could never repair it. Deleting here means an
    // edited message always has no chunks immediately after, so it is
    // correctly re-selected and re-indexed. A direct table delete (not the
    // memory layer) keeps this file free of that dependency.
    await tx
      .delete(conversationChunks)
      .where(eq(conversationChunks.messageId, message.id))

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
 * Delete an exact set of messages by ID, scoped to a single chat — used to
 * delete a single conversational turn (a user message + its assistant
 * response(s)) without touching anything before or after it. Unlike
 * deleteMessagesAfter/deleteMessagesFromIndex, this never implicitly
 * deletes anything beyond the IDs passed in.
 */
export async function deleteMessagesByIds(
  chatId: string,
  messageIds: string[],
  userId?: string
): Promise<{ count: number }> {
  if (messageIds.length === 0) {
    return { count: 0 }
  }

  return withOptionalRLS(userId || null, async tx => {
    const result = await tx
      .delete(messages)
      .where(and(eq(messages.chatId, chatId), inArray(messages.id, messageIds)))
      .returning({ id: messages.id })

    return { count: result.length }
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
      .orderBy(
        sql`${chats.lastViewedAt} DESC NULLS LAST`,
        desc(chats.createdAt)
      )
  })
}

export type ChatSortOption = 'recent' | 'newest' | 'oldest' | 'title'

function getChatSortOrderBy(sort: ChatSortOption) {
  switch (sort) {
    case 'newest':
      return [desc(chats.createdAt)]
    case 'oldest':
      return [asc(chats.createdAt)]
    case 'title':
      return [asc(sql`lower(${chats.title})`)]
    case 'recent':
    default:
      // Recently-viewed chats bubble to the top (Perplexity/ChatGPT-style);
      // falls back to creation date for chats that have never been reopened.
      return [sql`${chats.lastViewedAt} DESC NULLS LAST`, desc(chats.createdAt)]
  }
}

/**
 * Get chats with pagination
 */
export async function getChatsPage(
  userId: string,
  limit = 20,
  offset = 0,
  sort: ChatSortOption = 'recent'
): Promise<{ chats: Chat[]; nextOffset: number | null }> {
  try {
    return withRLS(userId, async tx => {
      const results = await tx
        .select()
        .from(chats)
        .where(eq(chats.userId, userId))
        .orderBy(...getChatSortOrderBy(sort))
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

export interface ChatBadgeData {
  searchMode?: SearchMode
  fileCount: number
}

/**
 * Batches two lightweight lookups per chat for the library list — the
 * search mode of the most recent message (reflects how the chat is
 * currently configured, not its full history) and a count of file
 * attachments — scoped to the given chatIds in two grouped queries rather
 * than one per chat.
 */
export async function getChatBadgeData(
  userId: string,
  chatIds: string[]
): Promise<Record<string, ChatBadgeData>> {
  if (chatIds.length === 0) return {}

  return withRLS(userId, async tx => {
    const [searchModeRows, fileCountRows] = await Promise.all([
      tx
        .selectDistinctOn([messages.chatId], {
          chatId: messages.chatId,
          searchMode: sql<string>`${messages.metadata}->>'searchMode'`
        })
        .from(messages)
        .where(
          and(
            inArray(messages.chatId, chatIds),
            sql`${messages.metadata}->>'searchMode' IS NOT NULL`
          )
        )
        .orderBy(messages.chatId, desc(messages.createdAt)),
      tx
        .select({
          chatId: messages.chatId,
          fileCount: sql<number>`count(*)::int`
        })
        .from(parts)
        .innerJoin(messages, eq(parts.messageId, messages.id))
        .where(and(inArray(messages.chatId, chatIds), eq(parts.type, 'file')))
        .groupBy(messages.chatId)
    ])

    const result: Record<string, ChatBadgeData> = {}
    for (const id of chatIds) {
      result[id] = { fileCount: 0 }
    }
    for (const row of searchModeRows) {
      if (result[row.chatId]) {
        result[row.chatId].searchMode = row.searchMode as SearchMode
      }
    }
    for (const row of fileCountRows) {
      if (result[row.chatId]) {
        result[row.chatId].fileCount = row.fileCount
      }
    }
    return result
  })
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
  snippet: string // ~150 chars of context around the match
  role: string // 'user' | 'assistant'
  lastViewedAt: Date | null
}

/**
 * Full-text search across chat titles and message text.
 * Returns up to 20 matching chats, most-recently-viewed first.
 */
export async function searchUserChatsKeyword(
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
      .leftJoin(
        parts,
        and(eq(parts.messageId, messages.id), eq(parts.type, 'text'))
      )
      .where(
        and(
          eq(chats.userId, userId),
          or(ilike(chats.title, term), ilike(parts.text_text, term))
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

/**
 * Rerank-scale gate for the semantic arm below (RECALL_SEARCH_MIN_SCORE).
 * More permissive than recall-inject's threshold (0.01 vs 0.05): a user who
 * typed a query wants candidates back, whereas auto-injecting noise
 * pollutes the prompt — but both sit far above the measured gibberish floor
 * (~0.0000164), so this is enough to reject unrelated chunks.
 */
function searchMinScore(): number {
  const n = Number(process.env.RECALL_SEARCH_MIN_SCORE)
  return Number.isFinite(n) ? n : 0.01
}

/**
 * Hybrid search core: unions the keyword arm (the floor, and the only arm
 * that searches chat titles) with the semantic recall arm (additive —
 * finds chats whose match lives only in un-indexed-by-title message
 * content). Extracted with an injectable keyword search so it is
 * unit-testable without a DB.
 *
 * Both arms always run, concurrently. Keyword results come first and keep
 * their existing order (today's behavior is preserved byte-for-byte);
 * semantic hits not already present are appended, then the union is
 * sliced to `limit`. The vector arm has no distance threshold (see
 * lib/db/recall-actions.ts), so once the index is non-empty it returns
 * hits for virtually any query — it can no longer be trusted alone to
 * decide "no results". "No results" is only honest when both arms agree,
 * which is why the semantic arm is gated by searchMinScore(): gibberish
 * queries no longer manufacture 5 unrelated hits. Welcome side effect: if
 * the reranker is down, the semantic arm fails closed to no hits and the
 * union floors out at keyword-only — exactly the intended degradation.
 */
export async function searchUserChatsHybrid(
  userId: string,
  query: string,
  limit: number,
  keywordSearch: (
    userId: string,
    query: string,
    limit: number
  ) => Promise<ChatSearchResult[]>
): Promise<ChatSearchResult[]> {
  const semanticSearch = async (): Promise<ChatSearchResult[]> => {
    try {
      const { recallSearch } = await import('@/lib/memory/recall-search')
      // recallSearch never throws — it returns []. That also covers the
      // fail-closed path: if the reranker is down, a rerank-scale minScore
      // can't be honoured against leftover cosine scores, so recallSearch
      // itself returns [] rather than everything. Either way `hits` is
      // simply empty, and this arm degrades to no semantic results below.
      const hits = await recallSearch(userId, query, {
        topK: limit,
        useRerank: true,
        minScore: searchMinScore()
      })
      // One row per chat, best-scoring chunk wins (hits are already sorted).
      const byChat = new Map<string, ChatSearchResult>()
      for (const h of hits) {
        if (byChat.has(h.chatId)) continue
        byChat.set(h.chatId, {
          chatId: h.chatId,
          chatTitle: h.chatTitle,
          snippet: h.content.slice(0, 150),
          role: h.role,
          lastViewedAt: null
        })
      }
      return [...byChat.values()]
    } catch {
      // Index unavailable/disabled/import failure — degrade to no semantic
      // hits. The keyword arm alone keeps the box working.
      return []
    }
  }

  const [keywordResults, semanticResults] = await Promise.all([
    keywordSearch(userId, query, limit),
    semanticSearch()
  ])

  const seen = new Set(keywordResults.map(r => r.chatId))
  const additiveSemantic = semanticResults.filter(r => !seen.has(r.chatId))

  return [...keywordResults, ...additiveSemantic].slice(0, limit)
}

/**
 * Full-text search across chat titles and message text.
 * Unions keyword and semantic recall — see searchUserChatsHybrid.
 */
export async function searchUserChats(
  userId: string,
  query: string,
  limit = 20
): Promise<ChatSearchResult[]> {
  return searchUserChatsHybrid(userId, query, limit, searchUserChatsKeyword)
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
 * Update chat title.
 *
 * Truncates to CHAT_TITLE_MAX_LENGTH as a backstop. `chats.title` is
 * unbounded `text`, and createChat/createChatAndSaveMessage already cap at
 * 255 with substring() — but this path did not, so a caller handing over a
 * runaway title wrote it verbatim. That happened in production: the title
 * model answered the user's question instead of titling it and the whole
 * answer landed here, giving four chats titles of up to 4,832 characters
 * that then rendered in the sidebar, the library, and recall's chips.
 * title-generator.ts now rejects such output at the source; this cap makes
 * the invariant hold for every caller of this function, not just that one.
 */
export async function updateChatTitle(
  chatId: string,
  title: string,
  userId?: string
): Promise<Chat | null> {
  const capped = title.substring(0, CHAT_TITLE_MAX_LENGTH)
  return withOptionalRLS(userId || null, async tx => {
    const [updatedChat] = await tx
      .update(chats)
      .set({ title: capped })
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
