import {
  deleteChunksForMessage,
  insertChunks,
  isRecallEnabled
} from '@/lib/db/recall-actions'
import { splitText } from '@/lib/embeddings/split-text'
import {
  embedTexts,
  getConfiguredModel
} from '@/lib/embeddings/transformers-embedding'

// Must match conversation_chunks.embedding vector(1024) — pinned to mxbai
// (EMBEDDING_MODEL). A mismatch means every insert fails, so fail LOUD.
const RECALL_EMBEDDING_DIM = 1024

function chunkTokens(): number {
  const n = Number(process.env.RECALL_CHUNK_TOKENS)
  return Number.isFinite(n) && n > 0 ? n : 512
}

function chunkOverlap(): number {
  const n = Number(process.env.RECALL_CHUNK_OVERLAP)
  return Number.isFinite(n) && n >= 0 ? n : 128
}

/**
 * Chunk + embed one message's text into conversation_chunks. Idempotent: any
 * existing chunks for the message are replaced, so a retry/edit re-indexes
 * cleanly. Never throws — recall is a background enhancement.
 */
export async function indexMessage(
  userId: string,
  chatId: string,
  messageId: string,
  role: 'user' | 'assistant',
  text: string
): Promise<number> {
  if (!text.trim()) return 0
  try {
    if (!(await isRecallEnabled(userId))) return 0

    const chunks = splitText(text, chunkTokens(), chunkOverlap())
    if (chunks.length === 0) return 0

    const embeddings = await embedTexts(chunks, getConfiguredModel())
    if (embeddings[0] && embeddings[0].length !== RECALL_EMBEDDING_DIM) {
      console.error(
        `[recall] embedding dimension mismatch: got ${embeddings[0].length}, expected ${RECALL_EMBEDDING_DIM}. ` +
          `Set EMBEDDING_MODEL=mixedbread-ai/mxbai-embed-large-v1. Skipping index.`
      )
      return 0
    }

    await deleteChunksForMessage(userId, messageId)
    await insertChunks(
      userId,
      chunks.map((content, i) => ({
        chatId,
        messageId,
        role,
        content,
        chunkIndex: i,
        embedding: embeddings[i]
      }))
    )
    return chunks.length
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('indexMessage failed:', error)
    }
    return 0
  }
}
