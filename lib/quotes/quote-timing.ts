// How long a quote stays on screen.
//
// Reading happens DURING the word-by-word reveal, not after it, so reveal time
// and reading time must not be summed — that double-counts and leaves long
// quotes sitting far too long. They compete instead, and the largest demand
// wins.

/** Reveal cadence for a normal-length quote. */
const REVEAL_PER_WORD_MS = 300
/** The pool runs to 80 words; at a flat cadence that is a 24s reveal. */
const REVEAL_CEILING_MS = 6000
/** Characters per second. Subtitling practice for adult viewers. */
const READ_CPS = 15
/** Added per punctuation mark — the pauses a reader actually takes. */
const PAUSE_MS = 180
/** The last word must not vanish the instant it lands — a beat to take it in. */
const TAIL_BASE_MS = 700
/** More words means more line to re-read once it is all there. */
const TAIL_PER_WORD_MS = 125
/** Past a point the eye has caught up; further tail is just dead screen. */
const TAIL_CEILING_MS = 3200
/** Nothing shows for less than this, however short. */
const FLOOR_MS = 3000
/** Average English word length, so difficulty is a ratio against normal. */
const AVG_WORD_CHARS = 5.1
/** Marks that stop the eye. Hyphens and apostrophes do not, so they are out. */
const PAUSE_CHARS = /[,;:.…—]/g

export type QuoteTiming = {
  words: number
  chars: number
  perWordMs: number
  revealMs: number
  tailMs: number
  readMs: number
  totalMs: number
  governedBy: 'read' | 'reveal' | 'floor'
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

export function quoteTiming(text: string): QuoteTiming {
  const words = text.split(/\s+/).filter(Boolean).length
  const chars = text.length

  if (words === 0) {
    return {
      words: 0,
      chars,
      perWordMs: REVEAL_PER_WORD_MS,
      revealMs: 0,
      tailMs: TAIL_BASE_MS,
      readMs: 0,
      totalMs: FLOOR_MS,
      governedBy: 'floor'
    }
  }

  // Long quotes tighten their cadence so they always finish arriving promptly.
  const perWordMs = Math.min(REVEAL_PER_WORD_MS, REVEAL_CEILING_MS / words)
  // Clamped because words * (REVEAL_CEILING_MS / words) is not exactly the
  // ceiling in floating point — at 79 words it comes back one ulp over.
  const revealMs = Math.min(REVEAL_CEILING_MS, words * perWordMs)
  const tailMs = Math.min(
    TAIL_BASE_MS + words * TAIL_PER_WORD_MS,
    TAIL_CEILING_MS
  )

  const difficulty = clamp(chars / words / AVG_WORD_CHARS, 0.9, 1.3)
  const pauses = (text.match(PAUSE_CHARS) ?? []).length
  const readMs = (chars / READ_CPS) * 1000 * difficulty + pauses * PAUSE_MS

  const revealTotal = revealMs + tailMs
  const totalMs = Math.max(readMs, revealTotal, FLOOR_MS)
  const governedBy =
    totalMs === readMs ? 'read' : totalMs === revealTotal ? 'reveal' : 'floor'

  return {
    words,
    chars,
    perWordMs,
    revealMs,
    tailMs,
    readMs,
    totalMs,
    governedBy
  }
}

export const QUOTE_FADE_OUT_MS = 420
export const QUOTE_AUTHOR_DELAY_MS = 150
