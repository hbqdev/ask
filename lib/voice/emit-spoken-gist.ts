import { firstSentences, stripForSpeech } from './strip-for-speech'

// Bound the spoken text so a very long answer is still read (truncated at a
// sentence boundary) rather than rejected by the speak route's size cap.
const MAX_SPOKEN_CHARS = 20000

// Clean the finished answer for speech and stream it as a data part, so the
// client reads the ACTUAL answer aloud (not a separate summary). Synchronous
// cleaning, no extra model call. Isolated + never throws so the streaming path
// stays unaffected if anything voice-related fails. (Kept the emitSpokenGist /
// data-spokenGist names for continuity; the payload is now the full answer.)
export async function emitSpokenGist(
  writer: { write: (part: unknown) => void },
  answerText: string
): Promise<void> {
  try {
    let text = stripForSpeech(answerText)
    if (text.length > MAX_SPOKEN_CHARS) {
      const head = text.slice(0, MAX_SPOKEN_CHARS)
      // Prefer whole sentences; fall back to the hard slice if there are none.
      text = firstSentences(head, 100000) || head
    }
    if (text) writer.write({ type: 'data-spokenGist', data: { text } })
  } catch (e) {
    console.warn('[voice] emitSpokenGist failed (ignored):', e)
  }
}
