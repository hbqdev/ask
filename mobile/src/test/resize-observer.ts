// jsdom has no ResizeObserver (and no layout). This stand-in records what
// each observer watches; a test calls resize(element) to deliver the callback
// a real layout change would.

const observers = new Set<StubResizeObserver>()

class StubResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>()

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.targets.add(target)
    observers.add(this)
  }

  unobserve(target: Element) {
    this.targets.delete(target)
  }

  disconnect() {
    this.targets.clear()
    observers.delete(this)
  }

  /** Delivers one entry for `target`, as the browser would after layout. */
  notify(target: Element) {
    this.callback([{ target } as ResizeObserverEntry], this)
  }
}

export function installResizeObserver() {
  globalThis.ResizeObserver = StubResizeObserver
}

/** Runs every observer watching `target`, as a change in its size would. */
export function resize(target: Element) {
  for (const observer of [...observers]) {
    if (observer.targets.has(target)) observer.notify(target)
  }
}
