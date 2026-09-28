import {
  findGluedPreambleSeam,
  findHeadingMatch,
  gluedAnswerOutweighsPreamble,
  looksLikeNarrationStart,
  shouldStripPreamble
} from './strip-narration-preamble'

// How many characters to buffer before giving up on waiting for a `## `
// heading and deciding, from the buffer alone, whether it looks like
// narration. Long enough to contain any complete NARRATION_STARTERS match
// (the longest is "let me (now )?consolidate", ~25 chars) with generous
// headroom; short enough that a clean answer with no heading (a refusal,
// a one-line factual answer) is never held for more than a beat.
const NARRATION_SNIFF_LIMIT = 64

// Hard ceiling on how long we'll buffer a plausible-narration prefix while
// waiting for the `## ` heading to show up. Raised to cover the round-cap
// leak: the largest narration block observed in production was a ~15KB
// chain-of-thought dump before its heading. Only a buffer that already reads
// as narration (`stillPlausible`) is ever held this long, so a genuine
// heading-less answer is still flushed early; this is purely the valve
// against a stream that talks forever without heading into an answer.
const NARRATION_HARD_MAX = 16000

/**
 * A `StreamTextTransform` factory that strips "thinking out loud"
 * narration some models emit as text-delta before the real answer.
 *
 * Every text-delta chunk received while `narrationMode` is true gets
 * buffered instead of forwarded. On each chunk we ask: has the answer's
 * `## ` heading shown up yet?
 *
 * - Glued seam first (`…breakdown.## Title`, the heading fused to the end of
 *   the preamble with no newline — any language) → the persist-time glued
 *   rule decides, through the SAME helpers (`findGluedPreambleSeam`,
 *   `gluedAnswerOutweighsPreamble`). Keep holding until the text after the
 *   seam outweighs the prefix, then emit from the `## ` on and pass the rest
 *   through. Why that release point: persist cuts only when the prefix is
 *   shorter than the whole answer after it, and a streamed answer only
 *   grows, so once the partial answer passes that guard the final one is
 *   certain to — the live cut is then exactly the cut persist will make.
 *   Releasing earlier could drop a prefix that persist would keep (a long
 *   preamble before a short answer). If a backtick precedes the seam on its
 *   line, also wait for that line to end: a closing backtick later on it
 *   would turn the `##` into inline code. A seam found before a line-start
 *   heading wins over it (that heading belongs to the answer). Until the cut
 *   is certain it keeps holding, bounded by the same ceiling, and a stream
 *   that ends first is flushed unchanged exactly as before.
 * - Heading at offset 0 → the buffer IS the answer, nothing to strip.
 *   Flush the whole buffer immediately and stop buffering. This is the
 *   common case for compliant models and must never be held indefinitely
 *   — `stripNarrationPreamble` returns text unchanged both when there's
 *   no heading yet AND when the heading is already at offset 0, so this
 *   transform can't rely on "did stripNarrationPreamble change the text"
 *   to know when to stop waiting; it has to check the heading position
 *   itself.
 * - Heading after some leading text → check whether that leading text
 *   looks like a narration pattern. If so, strip it and flush only the
 *   post-heading text. If not (a genuine intro paragraph), flush the
 *   whole buffer unchanged.
 * - No heading yet → keep buffering, but only while the buffer still
 *   plausibly looks like the start of a narration block AND stays under
 *   `NARRATION_HARD_MAX`. The moment either condition fails, flush
 *   whatever has accumulated — this bounds how long a refusal or a
 *   heading-less short answer can be held.
 *
 * Every flush is emitted as a `text-delta` chunk, never as extra fields
 * on `text-end` — both the server-side `toUIMessageStream` transform and
 * the client-side stream reducer forward only `id`/`providerMetadata`
 * from a `text-end` chunk and silently discard anything else attached to
 * it, so text placed there would vanish before reaching the UI or the
 * persisted message.
 */
export function smoothAndStripNarration() {
  return (_options: { tools: any; stopStream: () => void }) => {
    let buffer = ''
    let narrationMode = true

    return new TransformStream({
      transform(chunk: any, controller: TransformStreamDefaultController) {
        if (chunk.type === 'text-start') {
          // Begin a new text part. Reset buffers.
          buffer = ''
          narrationMode = true
          controller.enqueue(chunk)
          return
        }

        if (chunk.type === 'text-delta') {
          if (!narrationMode) {
            controller.enqueue(chunk)
            return
          }

          buffer += chunk.text

          const headingMatch = findHeadingMatch(buffer)
          const glued = findGluedPreambleSeam(buffer)
          if (
            glued &&
            (!headingMatch ||
              glued.seam < headingMatch.index + headingMatch.markerLength)
          ) {
            const answer = buffer.slice(glued.seam)
            // The seam is final once its line has ended, or when no backtick
            // precedes it on that line (only an inline-code span opened there
            // could still swallow the `##`).
            const lineStart = buffer.lastIndexOf('\n', glued.seam - 1) + 1
            const seamFinal =
              answer.includes('\n') ||
              !buffer.slice(lineStart, glued.seam).includes('`')
            if (
              seamFinal &&
              gluedAnswerOutweighsPreamble(glued.prefixLength, answer)
            ) {
              // Exactly `stripGluedHeadingPreamble`'s result for this text.
              narrationMode = false
              controller.enqueue({ ...chunk, text: answer })
              return
            }
            // Not decidable yet — hold (bounded by the same ceiling).
            if (buffer.length < NARRATION_HARD_MAX) return
            narrationMode = false
            controller.enqueue({ ...chunk, text: buffer })
            return
          }

          if (headingMatch) {
            narrationMode = false
            if (headingMatch.index === 0) {
              // Nothing to strip — the buffer is the answer.
              controller.enqueue({ ...chunk, text: buffer })
              return
            }
            const preamble = buffer.slice(0, headingMatch.index).trim()
            // Slice from the `##` itself (past any channel/think marker).
            // Not trimmed: the buffer ends mid-stream, so trailing whitespace
            // here is the heading line's newline, not the end of the answer.
            const flushed = shouldStripPreamble(preamble)
              ? buffer.slice(headingMatch.index + headingMatch.markerLength)
              : buffer
            controller.enqueue({ ...chunk, text: flushed })
            return
          }

          // No heading yet. Keep holding only while the buffer still
          // plausibly reads as narration and hasn't hit the hard cap.
          const stillPlausible =
            buffer.length < NARRATION_SNIFF_LIMIT ||
            looksLikeNarrationStart(buffer)
          if (stillPlausible && buffer.length < NARRATION_HARD_MAX) {
            // Hold the chunk back; nothing to enqueue yet.
            return
          }

          // Give up waiting — flush what we have as ordinary text.
          narrationMode = false
          controller.enqueue({ ...chunk, text: buffer })
          return
        }

        if (chunk.type === 'text-end') {
          if (narrationMode && buffer) {
            // The stream ended mid-buffer (e.g. a very short answer with
            // no heading). Flush via a synthetic text-delta — a text-end
            // chunk's extra fields are discarded downstream — then let
            // the real text-end through.
            controller.enqueue({
              type: 'text-delta',
              id: chunk.id,
              text: buffer
            })
            narrationMode = false
          }
          controller.enqueue(chunk)
          buffer = ''
          return
        }

        // Pass through reasoning, tool, finish, start, etc. unchanged.
        controller.enqueue(chunk)
      }
    })
  }
}
