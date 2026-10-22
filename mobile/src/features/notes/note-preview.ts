// A note's preview in the Notes list: its markdown as one line of plain text
// (link text without the URL, no heading, emphasis, list, quote or code
// marks), cut short.

/** The longest preview kept; the row clamps it to two lines anyway. */
export const NOTE_PREVIEW_MAX = 200

export function notePreview(content: string): string {
  return content
    .replace(/^```.*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NOTE_PREVIEW_MAX)
}
