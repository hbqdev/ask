// lib/voice/strip-for-speech.ts

// Turn written answer text into something a TTS model should read aloud: no
// citation anchors, tables, URLs, or markdown syntax. Complements
// extractIndexableText (which already removes citations) — kept independent so
// it can also clean a plain-text fallback.
export function stripForSpeech(text: string): string {
  return (
    text
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
      .trim()
  )
}

// First n sentence-ish chunks — the fallback spoken text when the gist model is
// unavailable.
export function firstSentences(text: string, n: number): string {
  const parts = text.match(/[^.!?]+[.!?]+(\s|$)/g)
  if (!parts) return text.trim()
  return parts.slice(0, n).join('').trim()
}
