import { getEncoding } from 'js-tiktoken'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

// Port of Vane's splitText: split on sentence/paragraph boundaries, pack the
// pieces into chunks of up to maxTokens, and start each chunk after the first
// with up to overlapTokens of the previous chunk's tail.
//
// Guarantees, on any input (prose, CSV, logs, minified JSON, CJK, one giant
// line), in tokens as countTokens below counts them, a chunk's count being the
// sum of its parts' (tokens merging across a seam only lower the real count):
//  - every chunk is at most maxTokens, overlap included;
//  - the carried overlap is at most overlapTokens (capped at maxTokens / 2 so
//    a chunk always has room for new text);
//  - nothing is dropped: a segment too big for one chunk is cut into pieces,
//    at whitespace when there is some, otherwise anywhere but inside a
//    surrogate pair. Only a single code point bigger than the whole budget
//    (impossible at real sizes) can exceed it;
//  - time is linear in the input size.
// With no overlap, prose comes out exactly as before these guarantees; with
// overlap, the overlap no longer overshoots overlapTokens by a word, so chunk
// boundaries after the first differ slightly (see split-text.test.ts).

let enc: ReturnType<typeof getEncoding> | null = null

function exactTokens(text: string): number {
  if (text.length === 0) return 0
  try {
    enc ??= getEncoding('cl100k_base')
    return enc.encode(text).length
  } catch {
    return Math.ceil(text.length / 4)
  }
}

// js-tiktoken's byte-pair merge is quadratic in the length of a pre-token, and
// cl100k makes one pre-token of every unbroken run of letters, of punctuation
// or of whitespace: 10 KB of letters takes ~11 s to encode. Such runs are
// counted by their UTF-8 byte length instead. Every token is at least one byte,
// so that is an upper bound, and it costs nothing. Normal text never has runs
// this long, so its count is exactly what the tokenizer says.
const LONG_RUN = /\p{L}{33,}|[^\s\p{L}\p{N}]{33,}|\s{65,}/gu

function countTokens(text: string): number {
  let total = 0
  let from = 0
  for (const run of text.matchAll(LONG_RUN)) {
    total +=
      exactTokens(text.slice(from, run.index)) +
      Buffer.byteLength(run[0], 'utf8')
    from = run.index + run[0].length
  }
  return from === 0 ? exactTokens(text) : total + exactTokens(text.slice(from))
}

const SEGMENT_BOUNDARY = /(?<=\. |\n|! |\? |; |:\s|\d+\.\s|- |\* )/

// No token, as counted above, spans more than ~65 characters, so a segment
// longer than this many characters per token of budget can't fit and goes
// straight to piece-cutting without being counted whole.
const MAX_CHARS_PER_TOKEN = 128

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

// fitWindow settles for any window filling at least this share of its limit,
// and aims its estimates at the middle of that band, so the first count of a
// window usually lands in it.
const GOOD_FILL = 0.9
const AIM = (1 + GOOD_FILL) / 2

/**
 * A window length (in UTF-16 units, 1..available) whose token count is within
 * `limit` and close to it, found by proportional estimates (seeded with the
 * text's `charsPerToken`) rather than a scan: usually a single count of a
 * window about `limit` tokens long. `measure(len)` counts that window.
 */
function fitWindow(
  available: number,
  limit: number,
  measure: (len: number) => number,
  charsPerToken: number
): [number, number] {
  const estimate = (chars: number, tokens: number) =>
    Math.floor((chars * limit * AIM) / Math.max(tokens, 1))
  let len = Math.max(1, Math.min(available, estimate(charsPerToken, 1)))
  let n = measure(len)
  for (let i = 0; i < 8 && n < limit * GOOD_FILL && len < available; i++) {
    len = Math.min(available, Math.max(len + 1, estimate(len, n)))
    n = measure(len)
  }
  while (n > limit && len > 1) {
    len = Math.max(1, Math.min(len - 1, estimate(len, n)))
    n = measure(len)
  }
  return [len, n]
}

/** Cut a segment that is over budget into pieces of at most `limit` tokens. */
function* pieces(segment: string, limit: number): Generator<[string, number]> {
  let start = 0
  let charsPerToken = 4
  while (start < segment.length) {
    const rest = segment.length - start
    const measure = (len: number) =>
      countTokens(segment.slice(start, start + len))
    const [fitted, fittedTokens] = fitWindow(
      rest,
      limit,
      measure,
      charsPerToken
    )
    let len = fitted
    let n = fittedTokens
    if (len < rest) {
      // Never split a surrogate pair; never cut mid-word when a later half of
      // the window has whitespace to cut after instead.
      if (isHighSurrogate(segment.charCodeAt(start + len - 1))) {
        len = len > 1 ? len - 1 : 2
      }
      const window = segment.slice(start, start + len)
      const lastSpace = window.search(/\s\S*$/)
      if (lastSpace >= len / 2) len = lastSpace + 1
      if (len !== fitted) n = measure(len)
    }
    if (n > 0) charsPerToken = len / n
    yield [segment.slice(start, start + len), n]
    start += len
  }
}

function* units(text: string, pieceLimit: number): Generator<[string, number]> {
  for (const segment of text.split(SEGMENT_BOUNDARY)) {
    if (segment.length > pieceLimit * MAX_CHARS_PER_TOKEN) {
      yield* pieces(segment, pieceLimit)
      continue
    }
    const n = countTokens(segment)
    if (n <= pieceLimit) yield [segment, n]
    else yield* pieces(segment, pieceLimit)
  }
}

/**
 * A suffix of `text` of nearly `budget` tokens and never more, with a token
 * count that is never below its real one. When the cut falls inside a word
 * and the suffix has whitespace, it starts at the next word instead (the
 * count of the window cut is kept: dropping a leading partial word only
 * lowers it); leading whitespace is dropped. `charsPerToken` (the text's
 * average) seeds the window estimate.
 */
function tailWithin(
  text: string,
  budget: number,
  charsPerToken: number
): [string, number] {
  if (budget <= 0 || text.length === 0) return ['', 0]
  const measure = (len: number) => countTokens(text.slice(text.length - len))
  let [len, n] = fitWindow(text.length, budget, measure, charsPerToken)
  if (len < text.length && isLowSurrogate(text.charCodeAt(text.length - len))) {
    len -= 1
  }
  let tail = text.slice(text.length - len)
  if (len < text.length && !/\s/.test(text[text.length - len - 1])) {
    const boundary = tail.search(/\s/)
    if (boundary !== -1) tail = tail.slice(boundary)
  }
  return [tail.replace(/^\s+/, ''), n]
}

class ChunkBuilder {
  readonly pieceLimit: number
  private readonly maxTokens: number
  private readonly overlapTokens: number
  private readonly chunks: string[] = []
  private current = ''
  private currentTokens = 0

  constructor(maxTokens: number, overlapTokens: number) {
    this.maxTokens = Math.max(1, Math.floor(maxTokens))
    this.overlapTokens = Math.max(
      0,
      Math.min(Math.floor(overlapTokens), Math.floor(this.maxTokens / 2))
    )
    // A piece plus a full overlap still fits in one chunk.
    this.pieceLimit = this.maxTokens - this.overlapTokens
  }

  add(unit: string, tokens: number): void {
    if (
      this.currentTokens + tokens > this.maxTokens &&
      this.current.length > 0
    ) {
      this.chunks.push(this.current.trim())
      const [overlap, overlapCount] = tailWithin(
        this.current,
        this.overlapTokens,
        this.current.length / Math.max(this.currentTokens, 1)
      )
      this.current = overlap + unit
      this.currentTokens = overlapCount + tokens
    } else {
      this.current += unit
      this.currentTokens += tokens
    }
  }

  finish(): string[] {
    if (this.current.trim().length > 0) this.chunks.push(this.current.trim())
    return this.chunks.filter(c => c.length > 0)
  }
}

export function splitText(
  text: string,
  maxTokens = 512,
  overlapTokens = 128
): string[] {
  const builder = new ChunkBuilder(maxTokens, overlapTokens)
  for (const [unit, tokens] of units(text, builder.pieceLimit)) {
    builder.add(unit, tokens)
  }
  return builder.finish()
}

// How long splitTextAsync may run before handing the event loop back.
const SLICE_MS = 15

/**
 * splitText for big inputs on a server's event loop: the same chunks, but the
 * work is cut into slices of about SLICE_MS with a yield between them, so
 * other requests are served while a large file is split.
 */
export async function splitTextAsync(
  text: string,
  maxTokens = 512,
  overlapTokens = 128
): Promise<string[]> {
  const builder = new ChunkBuilder(maxTokens, overlapTokens)
  let sliceStart = performance.now()
  for (const [unit, tokens] of units(text, builder.pieceLimit)) {
    builder.add(unit, tokens)
    if (performance.now() - sliceStart > SLICE_MS) {
      await yieldToEventLoop()
      sliceStart = performance.now()
    }
  }
  return builder.finish()
}
