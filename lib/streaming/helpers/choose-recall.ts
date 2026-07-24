// Decides how recall runs for a turn, given the classifier's output.
//   gated       — skipSearch turn: recall can't help (the answer comes from
//                 this chat's own context), so don't wait for it.
//   speculative — the classifier's standalone query equals the raw message,
//                 so a recall started on the raw message (before the classifier
//                 resolved) is valid — use it, having overlapped the classifier.
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
