// Drop the shared cloud provider tag from a model name so the phone-width
// model hint stays compact (e.g. "kimi-k2.6:cloud" -> "kimi-k2.6"). Only the
// known redundant tags are stripped; an internal identity colon like
// "qwen3.5:397b" is preserved. CSS truncation is the hard width safety net.
const KNOWN_TAG = /:(cloud|free|latest)$/i

export function modelShortName(name: string): string {
  if (typeof name !== 'string' || name.length === 0) return name ?? ''
  return name.replace(KNOWN_TAG, '')
}
