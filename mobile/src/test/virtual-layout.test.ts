import { afterEach, describe, expect, it } from 'vitest'

import { installVirtualLayout } from '@/test/virtual-layout'

const el = (attrs: Record<string, string> = {}) => {
  const node = document.createElement('div')
  for (const [name, value] of Object.entries(attrs)) {
    node.setAttribute(name, value)
  }
  document.body.append(node)
  return node
}

let restore: (() => void) | undefined

afterEach(() => {
  restore?.()
  restore = undefined
  document.body.replaceChildren()
})

describe('installVirtualLayout', () => {
  it('makes a scroller the viewport high and an item the item high', () => {
    restore = installVirtualLayout({ viewport: 300, item: 72 })
    const scroller = el({ 'data-scroll-root': '' })
    const item = el({ 'data-index': '3' })
    expect(scroller.clientHeight).toBe(300)
    expect(scroller.offsetHeight).toBe(300)
    expect(scroller.getBoundingClientRect().height).toBe(300)
    expect(item.clientHeight).toBe(72)
    expect(item.offsetHeight).toBe(72)
    expect(item.getBoundingClientRect().height).toBe(72)
  })

  it('leaves every other element at jsdom’s zeros', () => {
    restore = installVirtualLayout({ viewport: 300, item: 72 })
    const other = el()
    expect(other.clientHeight).toBe(0)
    expect(other.offsetHeight).toBe(0)
    expect(other.getBoundingClientRect().height).toBe(0)
  })

  it('restores jsdom’s layout', () => {
    installVirtualLayout({ viewport: 300, item: 72 })()
    const scroller = el({ 'data-scroll-root': '' })
    const item = el({ 'data-index': '0' })
    expect(scroller.clientHeight).toBe(0)
    expect(item.offsetHeight).toBe(0)
    expect(item.getBoundingClientRect().height).toBe(0)
    expect(
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    ).toBeUndefined()
    expect(
      Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'getBoundingClientRect'
      )
    ).toBeUndefined()
  })

  it('can be installed again with other sizes', () => {
    installVirtualLayout({ viewport: 300, item: 72 })()
    restore = installVirtualLayout({ viewport: 500, item: 100 })
    expect(el({ 'data-index': '0' }).offsetHeight).toBe(100)
    expect(el({ 'data-scroll-root': '' }).clientHeight).toBe(500)
  })
})
