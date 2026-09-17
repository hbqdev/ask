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
  // "I have enough info", and the broader family a model reaches for once it
  // decides it has finished researching: "I have comprehensive data now", "I
  // now have good coverage", "I have detailed specs", "I've gathered enough".
  // Observed live from deepseek-v4-flash:cloud on round-capped/single-pass
  // turns, emitted in the text part before the final `## ` heading.
  /^(?:i (?:now )?have (?:now )?(?:enough|comprehensive|sufficient|solid|good|detailed|adequate|complete|thorough|plenty|everything|all\b|the\b)|i'?ve (?:now )?(?:got|gathered) (?:enough|comprehensive|sufficient|good|solid|plenty|all\b|the\b))/i,
  /^(?:i'?ll research|let me research|i'?ll (?:dig|look) into|i'?ve (?:finished|completed) (?:my|the) research)/i,
  /^(?:i (?:will|shall) now|now (?:i will|i'll|let me))/i,
  /^(?:let me (?:now )?(?:write|synthesize|construct|craft|provide|put together|consolidate|refine|compile))/i,
  /^(?:i'll now (?:write|construct|compose|draft|provide))/i,
  /^(?:summary of (?:findings|results|key points))/i,
  /^(?:based on (?:my |the |our )?(?:research|findings|searches|results|analysis|sources?|the sources?|what i(?:'?ve| have)? (?:gathered|found)))/i,
  /^(?:wait,?\s+the\s+prompt)/i,
  /^(?:actually,?\s+(?:looking back|let me re-check|on second thought))/i,
  /^(?:let'?s\s+refine)/i,
  /^(?:refining the content)/i,
  // "Let me search for more…" / "I'll look for…" / "Let me fetch…" — a model
  // that wanted another search or fetch (e.g. a round-capped or single-pass
  // turn) narrating the tool call it is about to run, or was told it cannot
  // run, before the answer. Kept tight: the verb must be a search/lookup/
  // gather/fetch verb so genuine content like "Let me explain the difference"
  // is never a false positive.
  /^(?:let me|let's|i'?ll|i (?:will|shall|need to|want to|should|am going to)|i'?m going to|now (?:let me|i'?ll))\s+(?:also\s+|quickly\s+|just\s+|first\s+|now\s+|then\s+|go\s+(?:ahead\s+)?and\s+)*(?:do\s+(?:one\s+|a\s+|another\s+|a\s+few\s+more\s+)?(?:more\s+)?(?:quick\s+)?(?:search|searches)|run\s+(?:one\s+|a\s+|another\s+)?(?:more\s+)?(?:quick\s+)?(?:search|searches)|search|searching|look\s+(?:for|up|into)|gather\s+(?:more|additional|further)|dig\s+(?:up|into|deeper)|fetch(?:\s+(?:the|a|another|one|a\s+few))?|pull\s+up|retriev(?:e|ing)|verify\s+this|double[-\s]?check)\b/i,
  // Round-cap / limited-results narration. When the search-round budget is
  // exhausted the model tends to narrate the stop and inventory what each
  // source gave it before answering — e.g. "The search limit has been reached
  // (3 rounds). I have to answer with what I have. The Amazon fetch gave me
  // the full official description again. The Curmudgeonly Reader fetch
  // failed." None of these matched the research-done family above, so the
  // ~15KB preamble leaked verbatim into the answer (observed in prod).
  /^(?:the )?search (?:limit|budget|round limit) (?:has been|was|is) reached/i,
  /^(?:i (?:have to|need to|must|can only|'?ll|will|'?m going to|should) |let me )(?:just )?(?:go ahead and )?answer\b/i,
  /^(?:i'?ll|i will|i'?m going to|let me|i (?:have to|need to|must|should)) (?:just )?(?:go ahead and )?(?:answer|respond|reply|work|proceed|go)\b[^.!?]*\bwith what i(?:'?ve| have| got)\b/i,
  // "The Amazon fetch gave me…", "The Curmudgeonly Reader fetch failed",
  // "The search returned…" — a source-by-source inventory of the gathered
  // material. Anchored to a source noun + a tool verb so a genuine sentence
  // like "The fetch decorator caches results" is not a match.
  /^(?:the |my )?[\w."'’()-]+ (?:fetch|search|results?|page|review|lookup|query|call|blurb|snippet) (?:gave|returned|showed|provided|yielded|failed|didn'?t|did not|only|contained)\b/i,
  /^i (?:only |just |now )?have (?:only |just )?\d+ (?:results?|sources?|rounds?|pages?|hits?|reviews?)\b/i,
  /^i think i (?:have|now have|'?ve got) (?:enough|plenty|sufficient|good coverage)\b/i
]

// Sentence-level signals for the STRUCTURAL fallback below. A "research
// sentence" both LEADS with a first-person/meta process opener AND mentions a
// research/tool token. Requiring both keeps a lone genuine sentence like "I
// have three picks for you" (lead, no token) or "The search bar is on the
// left" (token, no lead) from counting.
const RESEARCH_LEAD =
  /^(?:i\b|we\b|let\b|let me\b|let(?:'|’)?s\b|now\b|so\b|okay\b|the user\b|key (?:points?|findings?)\b|one more\b|based on\b|from (?:the|my|our)\b|per\b)/i
const RESEARCH_TOKEN =
  /\b(?:search(?:es|ed|ing)?|fetch(?:ed|ing)?|results?|sources?|rounds?|round[- ]cap|evidence|coverage|toolcallid|tool call|cite|citations?|questions?|answers?|research|gathered|confirm(?:ed|s)?|verif(?:y|ied)|double[- ]?check|enough|the (?:amazon|goodreads|wikipedia|official|blurb|review)|blurb|reviews?|snippets?|the (?:page|fetch|search))\b/i

// Minimum preamble length before the STRUCTURAL signal is even considered.
// Justification: the largest GENUINE pre-heading intros seen in prod topped
// out around ~700 chars and carried at most one process sentence, while the
// smallest leaked chain-of-thought DUMP measured ~8KB with many. 1000 sits
// an order of magnitude below the dumps yet comfortably above real intros;
// the additional "3+ research sentences OR a stray think tag" requirement
// guards the gap so a rich but genuine multi-paragraph intro is not eaten.
const STRUCTURAL_PREAMBLE_MIN = 1000
const REASONING_SENTENCE_MIN = 3

/** Closing (or, in a leading block, opening) model reasoning tags. */
const THINK_TAG = /<\/?(?:think|mm:think)>/i
const CLOSE_THINK_TAG = /<\/(?:think|mm:think)>/gi

/**
 * True when a LARGE preamble carries strong reasoning signals even though it
 * matched none of the phrase-anchored `NARRATION_STARTERS` — a stray think
 * tag anywhere, or several first-person research sentences. This is the
 * backstop that keeps a big chain-of-thought dump on an UNLISTED opening
 * phrase (e.g. "I've confirmed the core mechanism…") from slipping through.
 */
/** Count sentences that both lead with a process opener and name a research token. */
function countResearchSentences(text: string): number {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/)
  let count = 0
  for (const sentence of sentences) {
    const s = sentence.trim()
    if (RESEARCH_LEAD.test(s) && RESEARCH_TOKEN.test(s)) count += 1
  }
  return count
}

function hasStrongReasoningSignal(text: string): boolean {
  if (text.length <= STRUCTURAL_PREAMBLE_MIN) return false
  if (THINK_TAG.test(text)) return true
  return countResearchSentences(text) >= REASONING_SENTENCE_MIN
}

/**
 * The strip decision for a heading's preamble, shared by the persist path
 * (`stripNarrationPreamble`) and the live stream transform so both agree:
 * strip when the preamble matches a known narration starter OR trips the
 * structural signal.
 */
export function shouldStripPreamble(preamble: string): boolean {
  return looksLikeNarrationStart(preamble) || hasStrongReasoningSignal(preamble)
}

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
 * immediately after a Vercel AI SDK channel marker like `<channel|>`, or
 * immediately after a model-specific closing think-tag like `</think>` or
 * `</mm:think>` (some models, e.g. minimax-m3, emit their reasoning inline
 * in the text stream instead of as a separate reasoning part, closed with
 * a custom tag right before the real answer with no newline in between —
 * seen in production as `...bullets.</mm:think>## Why Super Flower's...`).
 * Returns null if no heading is present yet.
 *
 * NOTE: we use `<[a-z]+\|>` rather than `<\|[^|]*\|>` because the latter
 * pattern is ambiguous to some JavaScript regex engines when `<\|`
 * appears at the start of an alternation group.
 */
export function findHeadingMatch(
  text: string
): { index: number; markerLength: number } | null {
  const match = /(^|\n|<[a-z]+\|>|<\/[a-z:]+>)(##\s)/.exec(text)
  if (!match) return null
  return { index: match.index, markerLength: match[1].length }
}

// Leads that mark the text before a stray close-think tag as leaked
// reasoning rather than answer prose. Used only to guard the think-tag cut,
// so a genuine answer that merely mentions the literal `</think>` tag (this
// user asks about model internals) keeps its content.
const REASONING_PREFIX_LEAD =
  /^(?:the user\b|i\b|we\b|let me\b|let(?:'|’)?s\b|now\b|so\b|okay\b|ok\b|good\b|great\b|hmm\b|alright\b|right,)/i

function looksLikeReasoningPrefix(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  // A stray think tag is a strong leak signal on its own, so this guard is
  // deliberately lower-threshold than `hasStrongReasoningSignal`: even a short
  // prefix is treated as reasoning if it opens with a reasoning lead, matches
  // a narration starter, or already carries two first-person research
  // sentences. A genuine answer that only mentions the literal tag mid-prose
  // matches none of these.
  return (
    REASONING_PREFIX_LEAD.test(t) ||
    looksLikeNarrationStart(t) ||
    countResearchSentences(t) >= 2
  )
}

/**
 * Belt-and-suspenders removal of leaked model reasoning delimited by think
 * tags, applied even when no `## ` heading follows. Some models emit their
 * chain-of-thought inline in the text stream (not as a separate reasoning
 * part) wrapped in — or closed by — a custom tag: a full leading
 * `<think>…</think>` block, or a stray `</think>` / `</mm:think>` with no
 * opener sitting between the reasoning and the real answer (e.g. the meme
 * reply "…a funny meme.</mm:think>Ha, that's a good comeback.").
 *
 * Only a LEADING reasoning block or a stray close tag whose PRECEDING text
 * reads like reasoning is cut, so a mid-answer or code-example mention of the
 * literal tag is preserved.
 */
export function stripStrayThinkTags(text: string): string {
  if (!text || typeof text !== 'string') return text
  if (!THINK_TAG.test(text)) return text

  // A full reasoning block at the very start: strip through its close tag.
  const leadingBlock = /^\s*<(think|mm:think)>[\s\S]*?<\/\1>/i.exec(text)
  if (leadingBlock) {
    return text.slice(leadingBlock.index + leadingBlock[0].length).trim()
  }

  // A stray close tag (no matching leading opener) with real content after
  // it: everything up to and including the LAST such tag is leaked reasoning.
  CLOSE_THINK_TAG.lastIndex = 0
  let lastClose: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  while ((match = CLOSE_THINK_TAG.exec(text)) !== null) {
    lastClose = match
  }
  if (lastClose) {
    const before = text.slice(0, lastClose.index)
    const after = text.slice(lastClose.index + lastClose[0].length).trim()
    if (after && looksLikeReasoningPrefix(before)) return after
  }

  return text
}

export function stripNarrationPreamble(text: string): string {
  if (!text || typeof text !== 'string') return text

  // First remove any leaked think-tag reasoning. This also handles the
  // no-heading case (reasoning closed by a stray tag with the answer after
  // it) that the heading-anchored logic below cannot reach.
  const cleaned = stripStrayThinkTags(text)

  // No heading at all → could be a refusal, short factual answer, or
  // single-line response. Leave it alone.
  const headingMatch = findHeadingMatch(cleaned)
  if (!headingMatch) return cleaned

  // The heading must appear after at least some leading content.
  // If `## ` is at the very start (offset 0), there's no preamble to
  // strip.
  if (headingMatch.index === 0) return cleaned

  // The content between the start and the heading is the candidate
  // preamble. Trim and check whether it looks like narration.
  const preamble = cleaned.slice(0, headingMatch.index).trim()
  if (!preamble) return cleaned

  // The preamble must itself look like narration — a known starter phrase or
  // a large dump tripping the structural signal. A genuine one-or-two-
  // sentence intro before the first heading matches neither and is kept.
  if (!shouldStripPreamble(preamble)) return cleaned

  // Strip the preamble. The slice starts at the start of the `## `
  // heading (skipping any preceding channel marker) so we don't leave
  // stray `<channel|>` tokens in the output.
  const headingStart = headingMatch.index + headingMatch.markerLength
  return cleaned.slice(headingStart).trim()
}
