// @vitest-environment node
import { getEncoding } from 'js-tiktoken'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import * as splitter from '../split-text'

const { splitText } = splitter

// The splitter's own tokenizer, used here as the independent ruler.
const enc = getEncoding('cl100k_base')
const tokens = (s: string) => enc.encode(s).length

const MB = 1024 * 1024
const FIXTURES = path.join(__dirname, 'fixtures', 'split-text')

// Deterministic PRNG so every generated input is identical run to run.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

function randomLetters(n: number, r: () => number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += LETTERS[Math.floor(r() * LETTERS.length)]
  return s
}

// The shape that froze the lab: `<row>,<~90 random letters>` lines, no spaces.
function lettersCsv(bytes: number, seed = 1): string {
  const r = rng(seed)
  let s = ''
  for (let i = 0; s.length < bytes; i++) {
    s += `${i},${randomLetters(40 + Math.floor(r() * 56), r)}\n`
  }
  return s.slice(0, bytes)
}

// A typical numeric export: short fields, commas, no spaces.
function numericCsv(bytes: number): string {
  let s = 'id,user,amount,created_at,status\n'
  for (let i = 0; s.length < bytes; i++) {
    s += `${i},u${(i * 7919) % 100003},${(i * 31) % 9973}.${i % 100},2026-10-${String(1 + (i % 28)).padStart(2, '0')}T12:${String(i % 60).padStart(2, '0')}:00Z,${i % 3 ? 'ok' : 'pending'}\n`
  }
  return s.slice(0, bytes)
}

// Minified JSON: one line, no spaces, short tokens.
function minifiedJson(bytes: number): string {
  let s = '['
  for (let i = 0; s.length < bytes; i++) {
    s += `{"id":${i},"k":"v${i % 97}","n":${(i * 13) % 1000}},`
  }
  return s.slice(0, bytes)
}

const CJK_POOL =
  '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可也你说年面发能下过子经现所'

// CJK prose: no spaces, punctuation every 8–30 characters, like real text.
function cjkProse(chars: number, seed = 7): string {
  const r = rng(seed)
  let s = ''
  while (s.length < chars) {
    const run = 8 + Math.floor(r() * 23)
    for (let i = 0; i < run; i++)
      s += CJK_POOL[Math.floor(r() * CJK_POOL.length)]
    s += r() < 0.7 ? '，' : '。'
  }
  return s.slice(0, chars)
}

function cjkNoPunctuation(chars: number, seed = 11): string {
  const r = rng(seed)
  let s = ''
  for (let i = 0; i < chars; i++)
    s += CJK_POOL[Math.floor(r() * CJK_POOL.length)]
  return s
}

/** The longest suffix of `prev` that `next` begins with: the carried overlap. */
function carried(prev: string, next: string): string {
  for (let k = Math.min(prev.length, next.length); k > 0; k--) {
    if (prev.endsWith(next.slice(0, k))) return next.slice(0, k)
  }
  return ''
}

function maxChunkTokens(chunks: string[]): number {
  return chunks.reduce((m, c) => Math.max(m, tokens(c)), 0)
}

function maxOverlapTokens(chunks: string[]): number {
  let m = 0
  for (let i = 1; i < chunks.length; i++) {
    m = Math.max(m, tokens(carried(chunks[i - 1], chunks[i])))
  }
  return m
}

/** Reassemble the source by dropping each chunk's carried overlap. */
function reassemble(chunks: string[]): string {
  let out = chunks[0] ?? ''
  for (let i = 1; i < chunks.length; i++) {
    out += chunks[i].slice(carried(chunks[i - 1], chunks[i]).length)
  }
  return out
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now()
  const value = fn()
  return { value, ms: performance.now() - t0 }
}

const PARAMS: Array<[number, number]> = [
  [512, 128],
  [256, 32]
]

// golden.json holds splitText's output on three prose documents, captured
// from the implementation before this fix. Without overlap the packing is
// unchanged, so the output must be byte-identical. With overlap it cannot be:
// the old code carried whole space-separated words until it reached
// overlapTokens, overshooting the bound on about half the chunk seams (and
// carrying whole chunks when the text had no spaces). The bounded overlap is a
// little shorter, which shifts later chunk boundaries. What must still hold is
// that the same text comes out: the first chunk is identical, the chunk count
// stays within 10%, and dropping each chunk's overlap gives back the document.
describe('splitText — golden output on prose', () => {
  const golden = JSON.parse(
    readFileSync(path.join(FIXTURES, 'golden.json'), 'utf-8')
  ) as Record<string, Record<string, string[]>>
  const noSpace = (s: string) => s.replace(/\s+/g, '')

  for (const file of Object.keys(golden)) {
    const text = readFileSync(path.join(FIXTURES, file), 'utf-8')
    for (const key of Object.keys(golden[file])) {
      const [max, overlap] = key.split('/').map(Number)
      const before = golden[file][key]
      if (overlap === 0) {
        it(`${file} at ${key} is byte-identical to the output before the fix`, () => {
          expect(splitText(text, max, overlap)).toEqual(before)
        })
        continue
      }
      it(`${file} at ${key} carries the same text as the output before the fix`, () => {
        const after = splitText(text, max, overlap)
        expect(after[0]).toBe(before[0])
        expect(after.length).toBeGreaterThanOrEqual(before.length * 0.9)
        expect(after.length).toBeLessThanOrEqual(before.length * 1.1)
        expect(noSpace(reassemble(after))).toBe(noSpace(text))
        expect(noSpace(reassemble(before))).toBe(noSpace(text))
      })
    }
  }
})

describe('splitText — chunk and overlap bounds on any input', () => {
  const inputs: Array<[string, string]> = [
    ['prose', readFileSync(path.join(FIXTURES, 'glossary.md'), 'utf-8')],
    ['letters CSV', lettersCsv(40_000)],
    ['numeric CSV', numericCsv(40_000)],
    ['minified JSON', minifiedJson(40_000)],
    ['one giant random line', randomLetters(30_000, rng(3))],
    ['CJK prose', cjkProse(6_000)],
    ['CJK without punctuation', cjkNoPunctuation(3_000)]
  ]

  for (const [name, text] of inputs) {
    for (const [max, overlap] of PARAMS) {
      it(`${name} at ${max}/${overlap}: chunks ≤ maxTokens, overlap ≤ overlapTokens`, () => {
        const chunks = splitText(text, max, overlap)
        expect(chunks.length).toBeGreaterThan(1)
        expect(maxChunkTokens(chunks)).toBeLessThanOrEqual(max)
        expect(maxOverlapTokens(chunks)).toBeLessThanOrEqual(overlap)
      })
    }
  }

  it('a run of one repeated letter still yields bounded chunks', () => {
    const chunks = splitText('x'.repeat(20_000), 512, 128)
    expect(chunks.length).toBeGreaterThan(1)
    expect(maxChunkTokens(chunks)).toBeLessThanOrEqual(512)
  })

  it('loses no content: overlap-free reassembly of an unbroken line is the line', () => {
    const line = randomLetters(30_000, rng(5))
    expect(reassemble(splitText(line, 512, 128))).toBe(line)
    expect(splitText(line, 256, 0).join('')).toBe(line)
  })

  it('loses no content: every CSV row appears whole in some chunk', () => {
    const csv = lettersCsv(40_000, 9)
    const chunks = splitText(csv, 512, 128)
    const joined = chunks.join('\n')
    for (const row of csv.split('\n').filter(Boolean)) {
      expect(joined).toContain(row)
    }
  })

  it('returns no chunks for empty or whitespace-only text', () => {
    expect(splitText('', 512, 128)).toEqual([])
    expect(splitText('   \n\n\t  \n', 512, 128)).toEqual([])
  })

  it('stays bounded when overlapTokens is not smaller than maxTokens', () => {
    const text = readFileSync(path.join(FIXTURES, 'license.txt'), 'utf-8')
    const chunks = splitText(text, 64, 64)
    expect(chunks.length).toBeGreaterThan(1)
    expect(maxChunkTokens(chunks)).toBeLessThanOrEqual(64)
    expect(maxOverlapTokens(chunks)).toBeLessThanOrEqual(64)
  })

  it('handles a tiny maxTokens', () => {
    const chunks = splitText('hello world. foo bar baz. qux quux corge.', 3, 1)
    expect(chunks.length).toBeGreaterThan(1)
    expect(maxChunkTokens(chunks)).toBeLessThanOrEqual(3)
  })
})

describe('splitText — linear time', () => {
  // Measured before the fix: the lab's 1 MB letters CSV took ~19 s, and one
  // unbroken 40 KB line ~3 min (it never finished at 1 MB).
  const cases: Array<[string, (bytes: number) => string]> = [
    ['letters CSV', bytes => lettersCsv(bytes)],
    ['numeric CSV', bytes => numericCsv(bytes)],
    ['one giant random line', bytes => randomLetters(bytes, rng(13))],
    ['one giant repeated letter', bytes => 'x'.repeat(bytes)]
  ]

  for (const [name, make] of cases) {
    it(`${name}: 1 MB in well under 3 s, chunk count proportional to size`, () => {
      const half = timed(() => splitText(make(MB / 2), 512, 128))
      const full = timed(() => splitText(make(MB), 512, 128))
      expect(full.ms).toBeLessThan(3000)
      const ratio = full.value.length / half.value.length
      expect(ratio).toBeGreaterThan(1.8)
      expect(ratio).toBeLessThan(2.2)
    }, 20_000)
  }
})

describe('splitTextAsync', () => {
  it('produces exactly what splitText produces', async () => {
    expect(typeof splitter.splitTextAsync).toBe('function')
    const texts = [
      readFileSync(path.join(FIXTURES, 'glossary.md'), 'utf-8'),
      lettersCsv(100_000),
      randomLetters(20_000, rng(17)),
      ''
    ]
    for (const text of texts) {
      for (const [max, overlap] of PARAMS) {
        expect(await splitter.splitTextAsync(text, max, overlap)).toEqual(
          splitText(text, max, overlap)
        )
      }
    }
  })

  it('never holds the event loop for long while splitting 2 MB', async () => {
    expect(typeof splitter.splitTextAsync).toBe('function')
    const text = lettersCsv(2 * MB)
    let last = performance.now()
    let maxGap = 0
    let ticks = 0
    let running = true
    const tick = () => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
      ticks++
      if (running) setImmediate(tick)
    }
    setImmediate(tick)
    const chunks = await splitter.splitTextAsync(text, 512, 128)
    running = false
    expect(chunks.length).toBeGreaterThan(100)
    expect(ticks).toBeGreaterThan(5)
    // Target is ~100 ms; the bound is loose for slow CI machines.
    expect(maxGap).toBeLessThan(250)
  }, 20_000)
})
