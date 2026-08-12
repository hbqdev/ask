import { condenseForSpeech } from './spoken-gist'

// Condense the finished answer and stream it as a data part. Isolated + never
// throws so the streaming path stays unaffected if anything voice-related fails.
export async function emitSpokenGist(
  writer: { write: (part: unknown) => void },
  answerText: string,
  opts: { abortSignal?: AbortSignal } = {}
): Promise<void> {
  try {
    const text = await condenseForSpeech(answerText, opts)
    if (text) writer.write({ type: 'data-spoken-gist', data: { text } })
  } catch (e) {
    console.warn('[voice] emitSpokenGist failed (ignored):', e)
  }
}
