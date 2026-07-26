// Decides a turn's expanded search queries once the classifier can produce
// them itself.
//
// Why: the classifier and the expander are two serial calls to the same model
// on the same host — classify 6.9-9s, then expand 6.6-12.3s — and the second
// cannot start until the first resolves, because it needs standaloneQuery.
// Vane gets classification and its standalone rewrite from one call. Folding
// expansion into the classifier removes a whole round trip, and does so
// whether that call ends up running locally or in the cloud.
//
// The separate expander survives as a fallback: an older model, a refusal or a
// schema miss must not silently cost the turn its expansion.

/** Matches the expander's contract — see lib/agents/query-expander.ts. */
const MAX_EXPANDED_QUERIES = 3

function clean(queries: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const q of queries) {
    const t = q.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length === MAX_EXPANDED_QUERIES) break
  }
  return out
}

export async function resolveExpandedQueries({
  fromClassifier,
  wantsExpansion,
  fallback
}: {
  fromClassifier: string[] | undefined
  wantsExpansion: boolean
  fallback: () => Promise<string[]>
}): Promise<string[]> {
  if (!wantsExpansion) return []

  const fused = clean(fromClassifier ?? [])
  if (fused.length > 0) return fused

  // Fused call gave nothing usable — pay for the second round trip rather
  // than silently narrowing the search.
  try {
    return clean(await fallback())
  } catch {
    // Expansion is optional; the turn is not.
    return []
  }
}
