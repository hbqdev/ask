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

// Must match conversation_chunks.embedding vector(1024) — the embedder is
// EMBEDDING_MODEL = Qwen/Qwen3-Embedding-0.6B (1024-d, served remote-only on
// the GPU embedder). The stored vectors are DATA-LOCKED to this model: never
// switch EMBEDDING_MODEL without a full re-embed of conversation_chunks, or
// recall silently returns garbage. The dim guard below only catches a
// DIFFERENT dimension — another 1024-d model (e.g. mxbai) would pass it
// silently while corrupting recall, so this is a landmine, not a safety net.
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
          `EMBEDDING_MODEL must stay Qwen/Qwen3-Embedding-0.6B (1024-d); the stored ` +
          `vectors are data-locked to it. Skipping index.`
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
