export interface RecallHit {
  chunkId: string
  chatId: string
  chatTitle: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
  /** Cosine similarity when useRerank is false; cross-encoder score once rerank actually runs. */
  score: number
}

export interface RecallOptions {
  topK: number
  useRerank: boolean
  excludeChatId?: string
  /**
   * A gate on whatever scale `score` currently is — NOT a fixed cosine
   * threshold. With useRerank: false that scale is cosine. With
   * useRerank: true and rerank actually running, that scale is the
   * cross-encoder's (measured: relevant ~0.169 vs irrelevant ~0.0000164,
   * ~10,000x apart — cosine cannot discriminate this cleanly, measured at
   * ~0.626 vs ~0.570). If useRerank: true is requested but rerank did NOT
   * run (cross-encoder unconfigured, or scoring threw), recallSearch cannot
   * honour a rerank-scale minScore against leftover cosine scores, so it
   * fails closed and returns [] rather than silently comparing across
   * scales.
   */
  minScore?: number
}
