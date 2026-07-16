export interface RecallHit {
  chunkId: string
  chatId: string
  chatTitle: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
  /** Cosine similarity when useRerank is false; cross-encoder score when it ran. */
  score: number
}

export interface RecallOptions {
  topK: number
  useRerank: boolean
  excludeChatId?: string
  /** Only valid with useRerank: false — it is a cosine threshold. */
  minScore?: number
}
