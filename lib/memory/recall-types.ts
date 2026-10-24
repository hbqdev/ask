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
  /**
   * Collapse candidates whose normalized text is identical (see
   * recallTextTokens), keeping the higher-scored copy, BEFORE the rerank pool
   * is chosen — so pool slots and injected slots are not spent on the same
   * text twice. Opt-in: the injection and the `recall` tool set it; the
   * Library search does not, because it lists CHATS and identical text in two
   * chats is two results there.
   */
  dedupe?: boolean
  /**
   * Drop candidates that are a near-verbatim repeat of any of these texts
   * (see isQueryEcho), BEFORE the rerank pool is chosen. Auto-injection
   * passes the query and the user's literal message: a past copy of the
   * question tells the model nothing it does not already have. Unset/empty =
   * off (the `recall` tool and the Library search keep them).
   */
  dropEchoesOf?: string[]
}

/**
 * Output of recall's cheap retrieval stage (embed + both DB arms), input to
 * its rerank stage. Split so the chat turn can retrieve speculatively while
 * the classifier runs, without spending reranker GPU time on a query it may
 * discard (see getRecallInjection / prefetchRecallCandidates).
 */
export interface RecallCandidates {
  /** The query the candidates were retrieved for — and must be reranked against. */
  query: string
  /** Vector arm, cosine descending. */
  vectorHits: RecallHit[]
  /** Keyword (ILIKE) arm, recency order, score 0. */
  keywordHits: RecallHit[]
}
