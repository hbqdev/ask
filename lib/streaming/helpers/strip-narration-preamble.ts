/**
 * Strips "thinking out loud" narration that some models (notably
 * gemma4:31b:cloud) emit as text-delta BEFORE the actual answer.
 *
 * The narration pattern observed in the wild:
 *   "I have enough information to construct a comprehensive answer.
 *    Summary of findings: ...
 *    Wait, the prompt says ... Actually, looking back at the tool history...
 *    Let's refine the content. I have enough info. I will now write the
 *    response. ## Remedying Canker Sores ..."
 *
 * The fix is heuristic but conservative: only strip when the text
 * contains a level-2 markdown heading (`## `) AND the content before
 * that heading matches a known narration starter. Anything else is
 * returned unchanged, so refusals, single-line answers, and answers
 * that genuinely start with an intro paragraph are preserved.
 */
const NARRATION_STARTERS: RegExp[] = [
  /^(?:i have enough|i've got enough)/i,
  /^(?:i (?:will|shall) now|now (?:i will|i'll|let me))/i,
  /^(?:let me (?:now )?(?:write|synthesize|construct|craft|provide|put together|consolidate|refine|compile))/i,
  /^(?:i'll now (?:write|construct|compose|draft|provide))/i,
  /^(?:summary of (?:findings|results|key points))/i,
  /^(?:based on (?:my |the |our )?(?:research|findings|searches|results|analysis))/i,
  /^(?:wait,?\s+the\s+prompt)/i,
  /^(?:actually,?\s+(?:looking back|let me re-check|on second thought))/i,
  /^(?:let'?s\s+refine)/i,
  /^(?:refining the content)/i
]

/**
 * True if `text` (trimmed), or any sentence within it, starts with a known
 * narration pattern. Checking every sentence (not just the string as a
 * whole) matters because some models prepend an unrelated or garbled
 * sentence before the actual self-talk kicks in — e.g. "Coins are not
 * mentioned yet. I have enough search results..." — which would defeat a
 * whole-string `^`-anchored check even though the narration is obviously
 * present. Each candidate sentence is still matched with the same
 * `^`-anchored patterns, so a narration phrase appearing mid-sentence in
 * genuine content (not at a sentence boundary) is not a false positive.
 *
 * Exported so the stream transform can decide, chunk by chunk, whether an
 * in-progress buffer is still a plausible narration prefix — separate
 * from `stripNarrationPreamble`, which needs the complete text (including
 * the heading) to make its strip/no-strip decision.
 */
export function looksLikeNarrationStart(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (NARRATION_STARTERS.some(re => re.test(trimmed))) return true

  const sentences = trimmed.split(/(?<=[.!?])\s+|\n+/)
  return sentences.some(sentence =>
    NARRATION_STARTERS.some(re => re.test(sentence.trim()))
  )
}

/**
 * Find the first level-2 markdown heading (`## `) at the start of a line,
 * or immediately after a Vercel AI SDK channel marker like `<channel|>`
 * (these get concatenated into the text part when the model emits
 * channel-switch tokens in the same text-delta stream as the answer).
 * Returns null if no heading is present yet.
 *
 * NOTE: we use `<[a-z]+\|>` rather than `<\|[^|]*\|>` because the latter
 * pattern is ambiguous to some JavaScript regex engines when `<\|`
 * appears at the start of an alternation group.
 */
export function findHeadingMatch(
  text: string
): { index: number; markerLength: number } | null {
  const match = /(^|\n|<[a-z]+\|>)(##\s)/.exec(text)
  if (!match) return null
  return { index: match.index, markerLength: match[1].length }
}

export function stripNarrationPreamble(text: string): string {
  if (!text || typeof text !== 'string') return text

  // No heading at all → could be a refusal, short factual answer, or
  // single-line response. Leave it alone.
  const headingMatch = findHeadingMatch(text)
  if (!headingMatch) return text

  // The heading must appear after at least some leading content.
  // If `## ` is at the very start (offset 0), there's no preamble to
  // strip.
  if (headingMatch.index === 0) return text

  // The content between the start and the heading is the candidate
  // preamble. Trim and check whether it looks like narration.
  const preamble = text.slice(0, headingMatch.index).trim()
  if (!preamble) return text

  // The preamble must itself look like narration. If the user-visible
  // intro is genuine content (e.g. an intro sentence before the first
  // heading), preserve it.
  if (!looksLikeNarrationStart(preamble)) return text

  // Strip the preamble. The slice starts at the start of the `## `
  // heading (skipping any preceding channel marker) so we don't leave
  // stray `<channel|>` tokens in the output.
  const headingStart = headingMatch.index + headingMatch.markerLength
  return text.slice(headingStart).trim()
}
