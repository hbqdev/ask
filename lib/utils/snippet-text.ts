// Search providers (SearXNG, degoog, some APIs) return snippets/titles with
// highlight markup like `Node.<strong>js 27,</strong>` and HTML entities. They
// are rendered as escaped React text, so the tags showed up literally. This
// turns them into plain display text. Display-only: the value never reaches an
// HTML sink, so this is cosmetic, not a sanitizer.
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'"
}

export function snippetText(raw: string | undefined | null): string {
  if (!raw) return ''
  return raw
    // A real tag starts with a letter (or `/` + letter) right after `<`, so
    // plain text like "2 < 3 and 5 > 4" is left alone.
    .replace(/<\/?[a-zA-Z][^<>]{0,200}>/g, '')
    .replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (_, e: string) => ENTITIES[e])
    .replace(/&#(\d{1,6});/g, (_, n: string) => {
      const code = Number(n)
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    })
    .replace(/\s+/g, ' ')
    .trim()
}
