// Runs async tasks one at a time, in the order given: a task waits for the one
// before it to settle (fulfilled or not). One waiting for nothing starts at
// once, within the call.

export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>

export function serialQueue(): SerialQueue {
  let running = false
  const waiting: Array<() => void> = []

  const next = () => {
    running = false
    waiting.shift()?.()
  }

  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        running = true
        // A task that throws before it awaits still frees the queue.
        // The next task starts before this one's caller hears back.
        new Promise<T>(settle => settle(task()))
          .finally(next)
          .then(resolve, reject)
      }
      if (running) waiting.push(start)
      else start()
    })
}
