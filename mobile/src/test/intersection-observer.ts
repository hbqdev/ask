// jsdom has no IntersectionObserver (and no layout). This stand-in records
// what each observer watches; a test calls intersect(element) to deliver the
// entry a real scroll into view would.

const observers = new Set<StubIntersectionObserver>()

class StubIntersectionObserver implements IntersectionObserver {
  readonly targets = new Set<Element>()
  readonly root: Element | Document | null
  readonly rootMargin: string
  readonly thresholds: readonly number[] = [0]

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {}
  ) {
    this.root = options.root ?? null
    this.rootMargin = options.rootMargin ?? '0px'
  }

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

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  /** Delivers one entry for `target`. */
  notify(target: Element, isIntersecting: boolean) {
    this.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      this
    )
  }
}

export function installIntersectionObserver() {
  globalThis.IntersectionObserver = StubIntersectionObserver
}

/** Runs every observer watching `target`, as a scroll into (or out of) view would. */
export function intersect(target: Element, isIntersecting = true) {
  for (const observer of [...observers]) {
    if (observer.targets.has(target)) observer.notify(target, isIntersecting)
  }
}

/** Whether any observer is watching `target`. */
export function isObserved(target: Element) {
  return [...observers].some(o => o.targets.has(target))
}
