// Passthrough transform that reports the `type` of every UI-message part as it
// flows to the client, without altering the bytes.
//
// Why this exists alongside firstChunkTimer: that one stamps the FIRST chunk of
// any kind, which on a research turn is a tool call, not prose. Measured on
// staging, the first chunk landed at 13.5s while the first visible sentence
// landed at ~88s — a 46s interval that no existing mark could see. Reporting
// each part type lets LatencyTracker record when prose actually began, when the
// tool result came back, and therefore where that interval went.
//
// Deliberately dumb: it reports every occurrence and keeps no state. First-seen
// dedup belongs to the consumer so the rule lives in one place.

export function streamPartTimer<T>(
  onPart: (type: string) => void
): TransformStream<T, T> {
  return new TransformStream<T, T>({
    transform(chunk, controller) {
      try {
        const type = (chunk as { type?: unknown } | null)?.type
        if (typeof type === 'string') onPart(type)
      } catch {
        // Telemetry must never break a turn mid-answer.
      }
      controller.enqueue(chunk)
    }
  })
}
