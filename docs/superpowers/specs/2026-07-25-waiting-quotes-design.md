# Waiting Indicator: Elapsed Timer + Word-by-Word Quotes — Design

**Date:** 2026-07-25
**Status:** Approved by operator (5 design rounds; timing tuned and then verified
against the live 4,636-quote pool).

## Goal

While Ask is working, show an elapsed timer and a rotating quote that reveals one
word at a time, using a different animation each time the quote changes. Long
research turns (40–95s) get something to read; nothing else about the existing
indicator changes.

## What exists today

`components/research-process-section.tsx`, in-progress branch:

- `WildBreathGlyph` (spinning) + `.wb-rail` (the light sweep bar)
- Clicking reveals "Working on it — N steps so far"; clicking that opens the steps

All of that stays exactly as-is. This adds two things beside it: a timer and a
quote line.

## Timing model

Reading happens **during** the reveal, not after it, so reveal time and reading
time must not be summed — they compete, and the largest demand wins.

```
perWord  = min(300, 6000 / words)      // reveal is bounded, cadence adapts
reveal   = words * perWord             // therefore never exceeds 6000ms
tail     = min(700 + words * 125, 3200)
read     = (chars / 15) * 1000 * difficulty + pauses * 180
floor    = 3000

difficulty = clamp(chars / words / 5.1, 0.9, 1.3)
pauses     = count of [,;:.…—]

onScreen = max( read, reveal + tail, floor )
```

All values in ms.

| Constant | Value | Reason |
|---|---|---|
| reveal cadence | 300ms/word | Operator's call; anything quicker read as too fast |
| reveal ceiling | 6000ms | The pool runs to 80 words; at a flat 300ms/word that is a 24s reveal. Above ~20 words the cadence tightens so the quote always finishes arriving promptly. |
| reading rate | 15 cps | Subtitling practice for adult viewers |
| pause beat | 180ms | Per punctuation mark — the pauses a reader takes |
| tail | 700 + 125/word, max 3200 | Settle beat before the line is replaced; scales so long quotes don't vanish on their last word, capped so it can't run away |
| floor | 3000ms | Operator's minimum for anything the formula puts below it |
| difficulty | 0.9–1.3 | `5.1` is average English word length, so this is a ratio against normal |

**No maximum on `onScreen`.** A long quote genuinely needs its reading time —
450 characters at 15 cps *is* ~30 seconds — and truncating it would show text
too briefly to read, which is the thing this feature exists to avoid. The quote
is ambient: if the answer arrives first, it simply disappears.

Verified outputs (these become the unit tests):

| Words | Chars | perWord | On screen | Governed by |
|---|---|---|---|---|
| 5 | 26 | 300ms | 3.0s | floor |
| 8 | 55 | 300ms | 5.1s | read |
| 8 | 69 | 300ms | 6.2s | read |
| 10 | 57 | 300ms | 5.0s | reveal |
| 11 | 58 | 300ms | 5.4s | reveal |
| 12 | 72 | 300ms | 5.8s | reveal |
| 16 | 80 | 300ms | 7.5s | reveal |
| 30 | 165 | 200ms | ~14.3s | read |
| 80 | 450 | 75ms | ~32.9s | read |

Measured across the live pool: p25 6.2s, p50 9.2s, p75 12.4s, p90 18.7s, max
32.9s. The adaptive cadence leaves every operator-tuned value unchanged, because
all of them are ≤20 words where `perWord` is still 300ms.

The line fades out over **420ms** before being replaced, so the changeover is not
a hard cut. Fade start = `onScreen - 420`.

## Quote pool

The Couchbase `Quotes` bucket holds **4,636** quotes in one document
`quotes_collection`, each `{ q, a }`. Word counts run min 2 / median 19 /
p90 45 / max 80.

**No length cap** — any quote in the pool may be shown; the adaptive cadence
above is what makes long ones workable. The only filtering is integrity:

- non-empty `q` and `a`
- deduped case-insensitively on `q` (the live doc has 7 exact duplicates)

## Data flow and security

The waiting UI must never make a network call *while waiting*, and Couchbase
credentials must never reach the browser.

```
Couchbase  ──(native SDK, server-side only)──►  Next route handler
                                                      │ filter, dedupe, shuffle
                                                      ▼
                                            Redis  quotes:pool  (TTL 24h)
                                                      │
                                      GET /api/quotes?n=40
                                                      │ one fetch per page session
                                                      ▼
                                   Client cycles the batch locally
```

**This is the same middle-server pattern hbqnexus uses** (`api/random-quote.js`):
credentials stay server-side, the browser only ever talks to our own route. The
route handler is the middle server.

Two differences from hbqnexus, both deliberate:

1. **Connection reuse.** hbqnexus opens *and closes* a cluster connection per
   request. Ask holds one lazily-created connection for the process lifetime.
2. **Batch, not per-request.** hbqnexus fetches the whole document to return one
   random quote. Ask does that fetch at most once per 24h (Redis TTL) and serves
   batches, so a waiting user never triggers a Couchbase round-trip.

**Transport: the native `couchbase` SDK (^4.4.5), same as hbqnexus.** Verified
safe here — Ask's image is `node:22-slim` (Debian/glibc) and the SDK ships
prebuilt glibc binaries, so no build toolchain is added.

**Degradation, in order:**

1. Redis has a pool → serve from it (the normal path)
2. Redis empty/down → fetch Couchbase, populate Redis, serve
3. Couchbase unreachable → serve a **bundled fallback set** (~20 quotes in-repo)
4. Route fails entirely → the component renders timer + rail only, no quote

Nothing here can break a turn. The quote is decoration; a failure degrades to the
indicator we have today.

**New env vars** (none exist yet in Ask): `COUCHBASE_URL`, `COUCHBASE_USERNAME`,
`COUCHBASE_PASSWORD`, optional `COUCHBASE_QUOTES_BUCKET` (default `Quotes`) and
`COUCHBASE_QUOTES_DOC` (default `quotes_collection`). Absent → straight to the
bundled fallback, no errors, no noise in the logs beyond one warning.

## Reveal styles

Five, one picked at random per quote, never the same twice running:

| Style | Motion |
|---|---|
| Rise | Lifts into place from below the line |
| Focus | Resolves out of a soft blur |
| Drift | Slides in from the left, with the reading direction |
| Settle | Slight scale overshoot, then settles |
| Wipe | Uncovered left to right, like ink laid down |

Each word carries `animation-delay = wordIndex * perWord`. The author line
follows the last word by a further 150ms.

## Components

| File | Responsibility |
|---|---|
| `lib/quotes/quote-timing.ts` | Pure. `quoteTiming(text)` → `{ perWordMs, revealMs, tailMs, readMs, totalMs, governedBy }`. No DOM, no I/O. |
| `lib/quotes/quote-pool.ts` | Pure. `acceptQuote()`, `normalizePool()` — validate, dedupe, shuffle. |
| `lib/quotes/fallback-quotes.ts` | The bundled ~20-quote constant. |
| `lib/quotes/couchbase-quotes.ts` | Native SDK fetch, server-only. Never throws; returns `[]` on any failure. |
| `app/api/quotes/route.ts` | `GET` → Redis-cached batch, with the degradation chain above. |
| `components/waiting-quote.tsx` | Client. Word reveal, style rotation, fade-out, elapsed timer. |
| `components/research-process-section.tsx` | Wire the above into the in-progress branch. |

## Behaviour details

- **Timer format** `M:SS` (`0:14`, `1:22`), `tabular-nums`, ticking each second
  from turn start.
- **Quotes start immediately** — the operator's framing was "as long as we're
  waiting". A short turn shows one quote, governed by the 3s floor.
- **Reduced motion** (`prefers-reduced-motion`): the whole quote appears at once,
  no per-word animation, no fade-out. Rotation still happens on the same timing.
- **Unmount** clears all timers; nothing keeps running after the answer arrives.
- **A11y:** the quote container is `aria-live="polite"` so a screen reader hears
  each quote once, not each word. The timer is `aria-hidden` — it is ambient, and
  announcing it every second would be hostile.

## Testing

- **Unit (`quote-timing`)**: every row of the verified-outputs table, plus which
  term governs each. Must cover the floor case, a read-governed case, a
  reveal-governed case, and the adaptive-cadence cases (30 and 80 words) proving
  `revealMs` never exceeds 6000.
- **Unit (`quote-pool`)**: rejects missing/empty `q` or `a`, dedupes
  case-insensitively, accepts both a 2-word and an 80-word quote (no length cap).
- **Unit (`couchbase-quotes`)**: returns `[]` when env is unset, when the SDK
  throws, and when the document shape is unexpected — never throws.
- **Route**: serves from Redis when present; falls back to the bundled set when
  Couchbase and Redis are both unavailable; never 500s.
- **Component**: renders one span per word with the expected delays; picks a
  different style than the previous quote; clears timers on unmount.

## Out of scope

- Admin UI for curating quotes (the bucket is managed elsewhere).
- Any change to the rail, glyph, step list, or the click-to-expand behaviour.
- Categories/filtering by `type` — the live documents only carry `{ q, a }`.
