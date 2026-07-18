export type EnvLine =
  | { kind: 'pair'; key: string; value: string; raw: string }
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

export function parseEnv(text: string): EnvDoc {
  const trailingNewline = text.endsWith('\n')
  const body = trailingNewline ? text.slice(0, -1) : text
  const rawLines = body.length === 0 && !trailingNewline ? [] : body.split('\n')
  const lines: EnvLine[] = rawLines.map(raw => {
    const m = raw.match(PAIR)
    if (m) return { kind: 'pair', key: m[1], value: unquote(m[2]), raw }
    return { kind: 'other', raw }
  })
  return { lines, trailingNewline }
}

export function serializeEnv(doc: EnvDoc): string {
  const body = doc.lines.map(l => l.raw).join('\n')
  return doc.trailingNewline ? body + '\n' : body
}

export function getValue(doc: EnvDoc, key: string): string | undefined {
  for (const l of doc.lines) if (l.kind === 'pair' && l.key === key) return l.value
  return undefined
}

export function toValueMap(doc: EnvDoc): Record<string, string> {
  const out: Record<string, string> = {}
  for (const l of doc.lines) if (l.kind === 'pair') out[l.key] = l.value
  return out
}

export function setValue(doc: EnvDoc, key: string, value: string): EnvDoc {
  const raw = `${key}=${formatValue(value)}`
  let found = false
  const lines = doc.lines.map(l => {
    if (l.kind === 'pair' && l.key === key) {
      found = true
      return { kind: 'pair', key, value, raw } as EnvLine
    }
    return l
  })
  if (!found) lines.push({ kind: 'pair', key, value, raw })
  return { lines, trailingNewline: true }
}
