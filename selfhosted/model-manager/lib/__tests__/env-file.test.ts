import { describe, expect, it } from 'vitest'
import { getValue, parseEnv, serializeEnv, setValue, toValueMap } from '../env-file'

const SAMPLE = `# comment
OLLAMA_BASE_URL=http://192.168.50.231:11434

OLLAMA_MODELS=a:cloud, b:cloud
QUOTED="has space"
UNKNOWN_KEEP=1
`

describe('env-file', () => {
  it('round-trips unedited content byte-for-byte', () => {
    expect(serializeEnv(parseEnv(SAMPLE))).toBe(SAMPLE)
  })
  it('reads values, unquoting', () => {
    const d = parseEnv(SAMPLE)
    expect(getValue(d, 'OLLAMA_BASE_URL')).toBe('http://192.168.50.231:11434')
    expect(getValue(d, 'QUOTED')).toBe('has space')
    expect(getValue(d, 'MISSING')).toBeUndefined()
  })
  it('edits in place, preserving surrounding lines', () => {
    const d = setValue(parseEnv(SAMPLE), 'OLLAMA_BASE_URL', 'http://new:11434')
    const out = serializeEnv(d)
    expect(out).toContain('OLLAMA_BASE_URL=http://new:11434')
    expect(out).toContain('# comment')
    expect(out).toContain('UNKNOWN_KEEP=1')
  })
  it('quotes values that need it', () => {
    const d = setValue(parseEnv(SAMPLE), 'OLLAMA_BASE_URL', 'a b')
    expect(serializeEnv(d)).toContain('OLLAMA_BASE_URL="a b"')
  })
  it('appends a missing key', () => {
    const out = serializeEnv(setValue(parseEnv(SAMPLE), 'NEW_KEY', 'v'))
    expect(out).toContain('NEW_KEY=v')
  })
  it('builds a value map of all pairs', () => {
    const m = toValueMap(parseEnv(SAMPLE))
    expect(m.OLLAMA_MODELS).toBe('a:cloud, b:cloud')
    expect(m.UNKNOWN_KEEP).toBe('1')
  })
  it('does not fuse an inline comment into the value (read-modify-write safe)', () => {
    const src = 'OLLAMA_BASE_URL=http://h:11434 # local\n'
    const d = parseEnv(src)
    expect(getValue(d, 'OLLAMA_BASE_URL')).toBe('http://h:11434')
    // unedited round-trip preserves the comment byte-for-byte
    expect(serializeEnv(d)).toBe(src)
    // editing keeps the comment and never absorbs it into the value
    const d2 = setValue(d, 'OLLAMA_BASE_URL', 'http://new:11434')
    expect(serializeEnv(d2)).toBe('OLLAMA_BASE_URL=http://new:11434 # local\n')
    // a no-op re-save of the read value does not corrupt it
    const d3 = setValue(d, 'OLLAMA_BASE_URL', getValue(d, 'OLLAMA_BASE_URL')!)
    expect(getValue(d3, 'OLLAMA_BASE_URL')).toBe('http://h:11434')
    expect(serializeEnv(d3)).not.toContain('"http://h:11434 # local"')
  })
  it('getValue and toValueMap agree on duplicate keys (last wins)', () => {
    const d = parseEnv('A=first\nA=second\n')
    expect(getValue(d, 'A')).toBe('second')
    expect(toValueMap(d).A).toBe('second')
  })
  it('preserves absence of a trailing newline when editing', () => {
    const d = parseEnv('A=1')
    expect(serializeEnv(setValue(d, 'A', '2'))).toBe('A=2')
  })
  it('handles CRLF line endings losslessly and on edit', () => {
    const src = 'A=1\r\nB=2\r\n'
    const d = parseEnv(src)
    expect(serializeEnv(d)).toBe(src) // byte-for-byte
    expect(getValue(d, 'A')).toBe('1')
    expect(serializeEnv(setValue(d, 'A', '9'))).toBe('A=9\r\nB=2\r\n')
  })
  it('keeps a value that contains = intact', () => {
    const d = parseEnv('DB=postgres://u:p@h/db?x=1\n')
    expect(getValue(d, 'DB')).toBe('postgres://u:p@h/db?x=1')
    expect(serializeEnv(d)).toBe('DB=postgres://u:p@h/db?x=1\n')
  })
})
