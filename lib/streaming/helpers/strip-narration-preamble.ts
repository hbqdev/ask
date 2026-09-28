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

// ---------------------------------------------------------------------------
// Language-agnostic STRUCTURAL rules (D20 addendum, 2026-09-28).
//
// Everything above is phrase-anchored in English, so a model narrating in
// Vietnamese/Chinese/Spanish ("Tôi đã có đủ thông tin… Bây giờ viết câu trả
// lời.## …") sailed through every check. The rules below key off the SHAPE
// of the leak instead of its wording, and stay conservative: each fires only
// when several independent structural signals agree.
// ---------------------------------------------------------------------------

/** A markdown ATX heading at the start of a line (≤3 leading spaces). */
const LINE_START_HEADING = /(?:^|\n)[ \t]{0,3}#{1,6}[ \t]/
/** Ask's inline citation marker, e.g. `[3](#toolCallId)`. */
const CITATION_MARKER = /\[\d+\]\(#[^)\s]*\)/
/** A GFM table delimiter row, e.g. `|---|:--:|` or `--- | ---`. */
const TABLE_DELIMITER_ROW =
  /(?:^|\n)[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*(?=\n|$)/
/** A bullet or numbered list item at the start of a line. */
const LIST_ITEM = /(?:^|\n)[ \t]*(?:[-*+•]|\d{1,3}[.)])[ \t]+\S/g

/**
 * Blank out fenced code blocks and inline code spans (same length, newlines
 * kept) so a literal `##` inside code can never look like a heading seam and
 * index positions still line up with the original text. An unclosed fence
 * (mid-stream) masks through the end of the text — the conservative reading.
 */
function maskCode(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ')
  return text
    .replace(
      /(^|\n)[ \t]{0,3}(`{3,}|~{3,})(?:[^\n]*\n(?:[\s\S]*?\n)?[ \t]{0,3}\2[ \t]*(?=\n|$)|[\s\S]*$)/g,
      (m, lead: string) => lead + blank(m.slice(lead.length))
    )
    .replace(/(`+)[^`\n]+?\1/g, blank)
}

// Upper bound on the text in front of a glued `## ` seam. Measured: the three
// Vietnamese preambles on prod (chat pq6zs7w88m1kmowjdu9udfrw, 2026-09-28)
// were 613, 653 and 673 chars — 6–9% of their answers; a Khmer stray glyph
// ("និ## How to…") was 2. D20's corpus puts genuine intros at ≤~700 chars and
// the smallest reasoning DUMP at ~8 KB (those carry English starters and are
// handled by the phrase rules above). 2,000 is ~3× the largest observed
// non-English preamble while staying far below the dump range, so a big
// block of real prose is never eaten on the seam signal alone.
const GLUED_PREAMBLE_MAX = 2000

/**
 * Index of the first `## ` heading GLUED to preceding content on the same
 * line (`…chương.## Title`, `…rồi.</think>## Title`), outside code. The
 * character before `##` must be non-space and not `#` (so `###` is never
 * split) nor `\` (an escaped, literal hash). A `## ` preceded by a space —
 * e.g. prose that mentions "use ## for headings" — is not a seam. Returns the
 * index of the `##`, or null.
 */
export function findGluedHeadingSeam(text: string): number | null {
  if (!text || !text.includes('##')) return null
  const match = /[^\s#\\]##[ \t]/.exec(maskCode(text))
  return match ? match.index + 1 : null
}

/**
 * The first glued `## ` seam in `text` (`findGluedHeadingSeam`) when the text
 * in front of it qualifies as a preamble ON ITS OWN: no heading of its own
 * (else the seam is a missing newline INSIDE the answer), no citation marker
 * (narration never cites; answer prose does), and ≤ GLUED_PREAMBLE_MAX chars
 * trimmed. Returns the seam index and the trimmed prefix length, or null.
 *
 * Everything here depends only on the text up to the seam, so the live stream
 * transform can evaluate it on a partial buffer. The remaining guard — the
 * answer must outweigh the prefix — is `gluedAnswerOutweighsPreamble`.
 */
export function findGluedPreambleSeam(
  text: string
): { seam: number; prefixLength: number } | null {
  const seam = findGluedHeadingSeam(text)
  if (seam === null) return null

  // The seam needs a non-space character before `##`, so the prefix is never
  // blank here.
  const prefix = text.slice(0, seam)
  const prefixLength = prefix.trim().length
  if (LINE_START_HEADING.test(maskCode(prefix))) return null
  if (CITATION_MARKER.test(prefix)) return null
  if (prefixLength > GLUED_PREAMBLE_MAX) return null
  return { seam, prefixLength }
}

/**
 * The last glued-seam guard: the text after the seam must be strictly longer
 * (trimmed) than the prefix in front of it, so a long preamble is never cut
 * from a short answer. Monotone in `answer`: appending text never shrinks its
 * trimmed length, so once a PARTIAL streamed answer passes, the complete one
 * will too — which is what lets the live transform decide before the end.
 */
export function gluedAnswerOutweighsPreamble(
  prefixLength: number,
  answer: string
): boolean {
  return answer.trim().length > prefixLength
}

/**
 * Cut a preamble fused IN FRONT OF the answer's first heading on the same
 * line, in any language. A `## ` that follows text on the same line does not
 * even render as a heading, and every mode's prompt makes the answer start
 * with `## `, so that glued seam is where narration ends and the answer
 * begins. The prefix is dropped only when it is plausibly a preamble:
 *
 * - it has no heading of its own (else the seam is a missing newline INSIDE
 *   the answer, and nothing is cut);
 * - it carries no citation marker (narration never cites; answer prose does);
 * - it is ≤ GLUED_PREAMBLE_MAX chars and shorter than what follows the seam.
 *
 * A proper `\n\n## ` heading after an intro paragraph is never a seam, so a
 * genuine intro is untouched here (the English phrase rules still apply).
 * The live transform (`smoothAndStripNarration`) makes the same cut through
 * the same two helpers, so the streamed and persisted text converge.
 */
export function stripGluedHeadingPreamble(text: string): string {
  const candidate = findGluedPreambleSeam(text)
  if (!candidate) return text
  const answer = text.slice(candidate.seam)
  if (!gluedAnswerOutweighsPreamble(candidate.prefixLength, answer)) return text
  return answer
}

// Upper bound for an inter-step text part to count as chatter on STRUCTURE
// alone. Measured across every stored prod+lab assistant message (831, as of
// 2026-09-28): text parts written right before a tool call are p50 ~110–180
// chars, p90 ~250–460; the non-English ones (vi/zh) were all 67–247. Longer
// ones were English phrase-rule hits, a structured partial answer (a
// `## Key Findings` block, 1,482 chars) that the guards below keep anyway, or
// a handful of 600–1,600-char reasoning notes this rule deliberately leaves
// alone. 600 covers the chatter with headroom and stays below the ~700-char
// mark where D20 saw genuine prose begin.
const INTER_STEP_CHATTER_MAX = 600

/**
 * True when a text part is short, unstructured prose: ≤ 600 chars, and no
 * heading, table, code block, list of 3+ items, or citation marker. Used
 * ONLY for a non-final text part that a tool call follows — process chatter
 * by construction ("Tôi cần đọc trang này…", "让我搜索一下…", "Déjame buscar…")
 * — so an interim note in any language is recognised without a phrase list,
 * while a structured partial answer written before a tool call is kept.
 */
export function looksLikeInterStepChatter(text: string): boolean {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t || t.length > INTER_STEP_CHATTER_MAX) return false
  if (/```|~~~/.test(t)) return false
  if (LINE_START_HEADING.test(t)) return false
  if (TABLE_DELIMITER_ROW.test(t)) return false
  if (CITATION_MARKER.test(t)) return false
  if ((t.match(LIST_ITEM) ?? []).length >= 3) return false
  return true
}

/**
 * Persist/render-time cleanup of a single text part: the English phrase and
 * think-tag rules first (unchanged behaviour), then the language-agnostic
 * glued-seam cut on what remains. Idempotent.
 */
export function stripNarrationPreamble(text: string): string {
  if (!text || typeof text !== 'string') return text
  return stripGluedHeadingPreamble(stripPhraseAnchoredPreamble(text))
}

function stripPhraseAnchoredPreamble(text: string): string {
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
