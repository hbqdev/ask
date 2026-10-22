// lib/voice/strip-for-speech.ts
import { stripSpecBlocks } from '@/lib/render/strip-spec-blocks'

// Turn written answer text into something a TTS model should read aloud: no
// citation anchors, tables, code blocks, URLs, or markdown syntax. Complements
// extractIndexableText (which already removes citations) — kept independent so
// it can also clean a plain-text fallback.
export function stripForSpeech(text: string): string {
  return (
    // ```spec json-render blocks (the related-questions UI) are not prose:
    // drop terminated ones, then any unterminated trailing block (stream cut
    // before the closing fence) from its opening fence to the end.
    stripSpecBlocks(text)
      .replace(/```spec[\s\S]*$/, '')
      // fenced code blocks are not read out at all (only their backticks would
      // go below). A fence opens and closes only at a line start (up to three
      // spaces in), so ``` mentioned mid-line is prose; an unclosed fence
      // (stream cut) runs to the end.
      .replace(
        /^ {0,3}```[^\n]*(?:\n[\s\S]*?(?:^ {0,3}```[ \t]*$|(?![\s\S]))|(?![\s\S]))/gm,
        ' '
      )
      // horizontal rules (---, ***, ___ alone on a line)
      .replace(/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
      // [label](#call_id) citation anchors → removed entirely (drop the number)
      .replace(/\[[^\]]*\]\(#[^)]*\)/g, '')
      // [label](http…) markdown links → label
      .replace(/\[([^\]]*)\]\(https?:\/\/[^)]*\)/g, '$1')
      // whole markdown table blocks (lines that are pipe rows)
      .replace(/(?:^\s*\|.*\|\s*$\n?)+/gm, ' ')
      // bare URLs (but leave any trailing sentence punctuation intact)
      .replace(/https?:\/\/[^\s]*[^\s.,!?;:]/g, '')
      // headings, list bullets, blockquotes at line start
      .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|>\s+)/gm, '')
      // bold/italic/inline-code/strikethrough markers
      .replace(/(\*\*|__|\*|_|`|~~)/g, '')
      // collapse whitespace/newlines
      .replace(/\s+/g, ' ')
      // tidy a space that ends up before a period ("... at .")
      .replace(/\s+([.,!?;:])/g, '$1')
      // and a comma/semicolon/colon a dropped citation left before a
      // sentence end ("most [2](#a), [3](#b)." → "most.")
      .replace(/[,;:]+(?=[.!?])/g, '')
      .trim()
  )
}

// First n sentence-ish chunks — the fallback spoken text when the gist model is
// unavailable. A terminator only ends a sentence when whitespace or the end of
// the text follows it, so decimals like "1.6" or "102.2°F" stay inside their
// sentence and the first chunk always starts at the true start of the text.
export function firstSentences(text: string, n: number): string {
  const parts = text.trim().match(/[\s\S]*?[.!?]+(?=\s|$)/g)
  if (!parts) return text.trim()
  return parts.slice(0, n).join('').trim()
}
