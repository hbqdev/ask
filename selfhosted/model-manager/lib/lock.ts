// Serialize apply/restore operations. A single Node process serves this
// LAN-only tool, so an in-process promise-chain mutex is sufficient to
// guarantee two concurrent requests can't interleave .env writes or race
// container restarts. Each queued task runs only after the previous one
// settles (whether it resolved or rejected).
let tail: Promise<unknown> = Promise.resolve()

export function withApplyLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn)
  tail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}
