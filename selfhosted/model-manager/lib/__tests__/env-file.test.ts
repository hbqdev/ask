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
})
