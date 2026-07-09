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

export function stripNarrationPreamble(text: string): string {
  if (!text || typeof text !== 'string') return text

  // Match `## ` at start of line OR immediately after a Vercel AI SDK
  // channel marker like `<channel|>` (these get concatenated into the
  // text part when the model emits channel-switch tokens in the same
  // text-delta stream as the answer).
  // No heading at all → could be a refusal, short factual answer, or
  // single-line response. Leave it alone.
  // NOTE: we use `<[a-z]+\|>` rather than `<\|[^|]*\|>` because the
  // latter pattern is ambiguous to some JavaScript regex engines when
  // `<\|` appears at the start of an alternation group.
  const headingMatch = /(^|\n|<[a-z]+\|>)(##\s)/.exec(text)
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
  const looksLikeNarration = NARRATION_STARTERS.some(re => re.test(preamble))
  if (!looksLikeNarration) return text

  // Strip the preamble. The slice starts at the start of the `## `
  // heading (skipping any preceding channel marker) so we don't leave
  // stray `<channel|>` tokens in the output.
  const headingStart = headingMatch.index + headingMatch[1].length
  return text.slice(headingStart).trim()
}
