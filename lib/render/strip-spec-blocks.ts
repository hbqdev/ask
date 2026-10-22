/**
 * Remove ```spec fenced blocks from text content.
 * Used when copying message text to clipboard.
 * A block opens only at a line start (indented or not, as inside a list
 * item), so ```spec mentioned mid-line stays prose.
 */
export function stripSpecBlocks(text: string): string {
  return text
    .replace(/^[ \t]*```spec[\s\S]*?```/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
