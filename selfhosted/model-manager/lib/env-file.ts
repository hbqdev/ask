export type EnvLine =
  | {
      kind: 'pair'
      key: string
      value: string
      // Trailing inline comment INCLUDING its leading whitespace + '#', or ''.
      comment: string
      // '' or '\r' — preserves CRLF line endings on edit.
      eol: string
      raw: string
    }
  | { kind: 'other'; raw: string }

export interface EnvDoc {
  lines: EnvLine[]
  trailingNewline: boolean
}

const PAIR = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

function unquote(raw: string): string {
  const t = raw.trim()
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") {
    return t.slice(1, -1)
  }
  return t
}

function formatValue(v: string): string {
  if (v === '' || /[\s"'#=]/.test(v)) {
    return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  }
  return v
}

// Split the text after `KEY=` into its value portion and any trailing inline
// comment. For a quoted value the comment is whatever follows the closing
// quote; for an unquoted value an inline comment begins at the first
// whitespace-then-'#'. A bare '#' inside a value (e.g. p#ss) is NOT a comment.
function splitComment(rest: string): { valueRaw: string; comment: string } {
  const lead = rest.match(/^\s*/)![0]
  const body = rest.slice(lead.length)
  const q = body[0]
  if (q === '"' || q === "'") {
    let i = 1
    for (; i < body.length; i++) {
      if (q === '"' && body[i] === '\\') {
        i++
        continue
      }
      if (body[i] === q) break
    }
    const end = i < body.length ? i + 1 : body.length
    return { valueRaw: lead + body.slice(0, end), comment: body.slice(end) }
  }
  const m = rest.match(/(\s+#.*)$/)
  if (m) return { valueRaw: rest.slice(0, rest.length - m[1].length), comment: m[1] }
  return { valueRaw: rest, comment: '' }
}

export function parseEnv(text: string): EnvDoc {
  const trailingNewline = text.endsWith('\n')
  const body = trailingNewline ? text.slice(0, -1) : text
  const rawLines = body.length === 0 && !trailingNewline ? [] : body.split('\n')
  const lines: EnvLine[] = rawLines.map(raw => {
    const eol = raw.endsWith('\r') ? '\r' : ''
    const line = eol ? raw.slice(0, -1) : raw
    const m = line.match(PAIR)
    if (m) {
      const { valueRaw, comment } = splitComment(m[2])
      return {
        kind: 'pair',
        key: m[1],
        value: unquote(valueRaw.trim()),
        comment,
        eol,
        raw
      }
    }
    return { kind: 'other', raw }
  })
  return { lines, trailingNewline }
}

export function serializeEnv(doc: EnvDoc): string {
  const body = doc.lines.map(l => l.raw).join('\n')
  return doc.trailingNewline ? body + '\n' : body
}

export function getValue(doc: EnvDoc, key: string): string | undefined {
  // Last assignment wins — matches toValueMap and how env loaders resolve a
  // duplicated key.
  let found: string | undefined
  for (const l of doc.lines) if (l.kind === 'pair' && l.key === key) found = l.value
  return found
}

export function toValueMap(doc: EnvDoc): Record<string, string> {
  const out: Record<string, string> = {}
  for (const l of doc.lines) if (l.kind === 'pair') out[l.key] = l.value
  return out
}

export function setValue(doc: EnvDoc, key: string, value: string): EnvDoc {
  let found = false
  const lines = doc.lines.map(l => {
    if (l.kind === 'pair' && l.key === key) {
      found = true
      const raw = `${key}=${formatValue(value)}${l.comment}${l.eol}`
      return { ...l, value, raw }
    }
    return l
  })
  if (!found) {
    lines.push({
      kind: 'pair',
      key,
      value,
      comment: '',
      eol: '',
      raw: `${key}=${formatValue(value)}`
    })
  }
  return { lines, trailingNewline: doc.trailingNewline }
}
