// Decode HTML entities in plain-text strings coming from search sources
// (SearXNG bing-news, degoog news) before they are rendered.
//
// The Discover feed renders `title`/`content` directly as React text nodes,
// and text nodes do NOT decode entities — so a source string containing
// `&#x27;` renders as the literal six characters `&#x27;`. This runs
// server-side in the discover route to turn source HTML-encoding back into the
// text it represents. Node has no DOM parser here, so this is a small
// self-contained decoder rather than an added dependency.
//
// Named entities beyond this common set are left untouched (returned as-is)
// rather than mangled — this is news-headline text, not arbitrary HTML.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  deg: '°',
  middot: '·',
  bull: '•',
  eacute: 'é',
  egrave: 'è'
}

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g

// A single left-to-right replace pass: String.prototype.replace with a global
// regex scans the ORIGINAL string, so `&amp;#x27;` decodes `&amp;`→`&` and
// then does NOT re-examine the produced `&`, leaving `&#x27;` — no double decode.
export function decodeHtmlEntities(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input ?? ''
  if (input.indexOf('&') === -1) return input

  return input.replace(ENTITY_RE, (match, entity: string) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X'
      const codePoint = isHex
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10)
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        return match
      }
      try {
        return String.fromCodePoint(codePoint)
      } catch {
        return match
      }
    }
    const named = NAMED_ENTITIES[entity]
    return named !== undefined ? named : match
  })
}
