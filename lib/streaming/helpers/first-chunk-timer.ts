// Passthrough transform that stamps the first chunk. Used to measure true
// time-to-first-token on the researcher's UI-message stream without altering
// the bytes: every chunk is forwarded unchanged; onFirst() fires once.

export function firstChunkTimer<T>(onFirst: () => void): TransformStream<T, T> {
  let fired = false
  return new TransformStream<T, T>({
    transform(chunk, controller) {
      if (!fired) {
        fired = true
        onFirst()
      }
      controller.enqueue(chunk)
    }
  })
}
