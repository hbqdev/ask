import { describe, expect, it } from 'vitest'

import { clippingAncestors } from '@/test/clipping'

/** A tree from HTML, with the element marked data-target. */
function tree(html: string) {
  const root = document.createElement('div')
  root.innerHTML = html
  return { root, target: root.querySelector('[data-target]')! }
}

describe('clippingAncestors', () => {
  it('lists each ancestor up to the root whose overflow is hidden or clip', () => {
    const { root, target } = tree(
      `<div class="a overflow-hidden"><div class="overflow-x-clip"><div class="overflow-y-hidden">
        <div class="overflow-clip"><button data-target class="overflow-hidden"></button></div>
      </div></div></div>`
    )
    root.className = 'root overflow-hidden'
    expect(clippingAncestors(target, root)).toEqual([
      'overflow-clip',
      'overflow-y-hidden',
      'overflow-x-clip',
      'a overflow-hidden',
      'root overflow-hidden'
    ])
  })

  it('lets scrollers, visible overflow and look-alike classes through', () => {
    const { root, target } = tree(
      `<div class="overflow-y-auto"><div class="overflow-x-scroll"><div class="overflow-visible">
        <div class="md:overflow-hidden-ish text-overflow-hidden"><span data-target></span></div>
      </div></div></div>`
    )
    expect(clippingAncestors(target, root)).toEqual([])
  })

  it('stops at the root, not above it', () => {
    const outer = document.createElement('div')
    outer.className = 'overflow-hidden'
    const { root, target } = tree('<p><a data-target></a></p>')
    outer.append(root)
    expect(clippingAncestors(target, root)).toEqual([])
  })
})
