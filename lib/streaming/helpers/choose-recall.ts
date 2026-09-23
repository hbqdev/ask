// Decides how recall runs for a turn, given the classifier's output.
//   gated       — skipSearch turn: recall can't help (the answer comes from
//                 this chat's own context), so don't wait for it.
//   speculative — the classifier's standalone query equals the raw message,
//                 so the retrieval (embed + DB) prefetched on the raw message
//                 while the classifier ran is valid — rerank it; only the
//                 rerank is left on the critical path.
//   refetch     — the standalone query differs (context resolution), so the
//                 speculative recall used the wrong query; run recall on the
//                 resolved query (this equals today's behavior — no regression).
export type RecallDecision = 'gated' | 'speculative' | 'refetch'

export function chooseRecall(args: {
  skipSearch: boolean
  standaloneQuery: string
  latestMessageText: string
}): RecallDecision {
  if (args.skipSearch) return 'gated'
  const effectiveQuery = args.standaloneQuery || args.latestMessageText
  return effectiveQuery === args.latestMessageText ? 'speculative' : 'refetch'
}
