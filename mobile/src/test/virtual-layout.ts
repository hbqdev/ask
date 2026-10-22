// jsdom has no layout: every box is 0 high, so a virtualized list sees no
// viewport and mounts nothing. This gives the boxes a virtualizer reads a
// height: a scroller (`data-scroll-root`) is `viewport` high and a list item
// (`data-index`) is `item` high (or `item(el)`, for rows of several
// heights); anything else keeps jsdom's zeros.

type Layout = {
  viewport: number
  item: number | ((el: HTMLElement) => number)
}

const PROPS = ['offsetHeight', 'clientHeight', 'getBoundingClientRect'] as const

/** Installs the layout; returns the function that takes it away again. */
export function installVirtualLayout({ viewport, item }: Layout): () => void {
  const proto = HTMLElement.prototype
  const own = new Map(
    PROPS.map(name => [name, Object.getOwnPropertyDescriptor(proto, name)])
  )
  const offsetHeight = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')!
  const clientHeight = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'clientHeight'
  )!
  const rect = Element.prototype.getBoundingClientRect

  const heightOf = (el: HTMLElement): number | null =>
    el.hasAttribute('data-scroll-root')
      ? viewport
      : el.hasAttribute('data-index')
        ? typeof item === 'number'
          ? item
          : item(el)
        : null

  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return heightOf(this) ?? offsetHeight.get!.call(this)
    }
  })
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return heightOf(this) ?? clientHeight.get!.call(this)
    }
  })
  Object.defineProperty(proto, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      const height = heightOf(this)
      if (height === null) return rect.call(this)
      return new DOMRect(0, 0, 0, height)
    }
  })

  return () => {
    for (const [name, descriptor] of own) {
      if (descriptor) Object.defineProperty(proto, name, descriptor)
      else delete (proto as unknown as Record<string, unknown>)[name]
    }
  }
}
