import { defaultRangeExtractor } from '@tanstack/react-virtual'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  flattenGroups,
  itemEstimate,
  sectionHeader,
  stickyRangeExtractor,
  VirtualList,
  type VirtualItem
} from '@/core/ui/virtual-list'
import { resize } from '@/test/resize-observer'
import { installVirtualLayout } from '@/test/virtual-layout'

const keyOf = (row: string) => row

describe('flattenGroups', () => {
  it('heads each group, then its rows, the last of each with no separator', () => {
    expect(
      flattenGroups(
        [
          { label: 'Today', rows: ['a', 'b'] },
          { label: 'Yesterday', rows: ['c'] }
        ],
        ['a', 'b', 'c'],
        keyOf
      )
    ).toEqual([
      { kind: 'header', key: 'h:Today', label: 'Today' },
      { kind: 'row', key: 'r:a', row: 'a', separator: true },
      { kind: 'row', key: 'r:b', row: 'b', separator: false },
      { kind: 'header', key: 'h:Yesterday', label: 'Yesterday' },
      { kind: 'row', key: 'r:c', row: 'c', separator: false }
    ])
  })

  it('lists the rows alone, without groups (the title sort)', () => {
    expect(flattenGroups(null, ['a', 'b', 'c'], keyOf)).toEqual([
      { kind: 'row', key: 'r:a', row: 'a', separator: true },
      { kind: 'row', key: 'r:b', row: 'b', separator: true },
      { kind: 'row', key: 'r:c', row: 'c', separator: false }
    ])
  })

  it('keys rows by keyOf', () => {
    const rows = [{ id: 'x1' }]
    expect(flattenGroups(null, rows, r => r.id)[0].key).toBe('r:x1')
  })

  it('is empty for no rows, grouped or not', () => {
    expect(flattenGroups([], [], keyOf)).toEqual([])
    expect(flattenGroups(null, [], keyOf)).toEqual([])
  })
})

describe('stickyRangeExtractor', () => {
  const range = (startIndex: number, endIndex: number) => ({
    startIndex,
    endIndex,
    overscan: 2,
    count: 40
  })

  it('puts the header of the rows at the top first', () => {
    const r = range(12, 15)
    expect(stickyRangeExtractor([0, 5, 20])(r)).toEqual([
      5,
      ...defaultRangeExtractor(r)
    ])
  })

  it('takes the last header before the start, not an earlier one', () => {
    const r = range(30, 33)
    expect(stickyRangeExtractor([0, 5, 20])(r)).toEqual([
      20,
      ...defaultRangeExtractor(r)
    ])
  })

  it('adds nothing when that header is already in the range', () => {
    const r = range(6, 9)
    expect(stickyRangeExtractor([0, 5, 20])(r)).toEqual(
      defaultRangeExtractor(r)
    )
  })

  it('adds nothing when no header comes before the start', () => {
    const r = range(3, 8)
    expect(stickyRangeExtractor([5, 20])(r)).toEqual(defaultRangeExtractor(r))
    expect(stickyRangeExtractor([])(r)).toEqual(defaultRangeExtractor(r))
  })
})

// --- The list -------------------------------------------------------------------

// Rows and headers as tall as they measure at the default text size (the
// estimates), and a "tall" row for mixed heights.
const ROW = 88
const HEAD = 38
const sized = (el: HTMLElement) =>
  el.querySelector('h2') ? HEAD : el.textContent!.includes('tall') ? 150 : ROW

function List({ items }: { items: VirtualItem<string>[] }) {
  const scroller = useRef<HTMLDivElement>(null)
  return (
    <div ref={scroller} data-scroll-root data-testid="scroller">
      <VirtualList
        scroller={scroller}
        items={items}
        renderRow={(row, separator) => (
          <p data-separator={String(separator)}>{row}</p>
        )}
        renderHeader={(label, id) => <h2 id={id}>{label}</h2>}
      />
    </div>
  )
}

const rows = (n: number, prefix = 'Row') =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i}`)

/** Scrolls the list's scroller to `top`, as a finger would. */
function scrollTo(top: number) {
  const scroller = screen.getByTestId('scroller')
  act(() => {
    scroller.scrollTop = top
    fireEvent.scroll(scroller)
  })
}

const mounted = () =>
  [...document.querySelectorAll<HTMLElement>('[data-index]')].map(el =>
    Number(el.dataset.index)
  )

const item = (index: number) =>
  document.querySelector<HTMLElement>(`[data-index="${index}"]`)

let restore: (() => void) | undefined

afterEach(() => {
  restore?.()
  restore = undefined
  vi.restoreAllMocks()
})

describe('VirtualList', () => {
  it('mounts only the window', () => {
    restore = installVirtualLayout({ viewport: 300, item: sized })
    render(<List items={flattenGroups(null, rows(200), keyOf)} />)
    expect(screen.getByText('Row 0')).toBeInTheDocument()
    expect(screen.queryByText('Row 199')).toBeNull()
    expect(document.querySelectorAll('[data-index]').length).toBeLessThan(30)
    expect(
      document.querySelectorAll('[data-index]').length
    ).toBeGreaterThanOrEqual(Math.ceil(300 / ROW))
  })

  it('holds the whole list’s height, so the scroller scrolls it all', () => {
    restore = installVirtualLayout({ viewport: 300, item: sized })
    render(<List items={flattenGroups(null, rows(200), keyOf)} />)
    expect(item(0)!.parentElement!.style.height).toBe(`${200 * ROW}px`)
  })

  it('mounts the rows scrolled to and lets go of those scrolled past', () => {
    restore = installVirtualLayout({ viewport: 300, item: sized })
    render(<List items={flattenGroups(null, rows(200), keyOf)} />)
    scrollTo(150 * ROW)
    expect(screen.getByText('Row 150')).toBeInTheDocument()
    expect(screen.queryByText('Row 0')).toBeNull()
    expect(item(150)!.style.transform).toBe(`translateY(${150 * ROW}px)`)
    expect(item(150)!.style.position).toBe('absolute')
  })

  it('passes each row its separator, and marks every item with its index', () => {
    restore = installVirtualLayout({ viewport: 300, item: sized })
    render(
      <List
        items={flattenGroups(
          [
            { label: 'Today', rows: ['a', 'b'] },
            { label: 'Yesterday', rows: ['c'] }
          ],
          ['a', 'b', 'c'],
          keyOf
        )}
      />
    )
    expect(mounted()).toEqual([0, 1, 2, 3, 4])
    expect(screen.getByText('a').dataset.separator).toBe('true')
    expect(screen.getByText('b').dataset.separator).toBe('false')
    expect(screen.getByText('c').dataset.separator).toBe('false')
  })

  it('has no list role, and keeps each header a heading with its own id', () => {
    restore = installVirtualLayout({ viewport: 300, item: sized })
    render(
      <List
        items={flattenGroups(
          [
            { label: 'Today', rows: ['a'] },
            { label: 'Yesterday', rows: ['b'] }
          ],
          ['a', 'b'],
          keyOf
        )}
      />
    )
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('listitem')).toBeNull()
    const headings = screen.getAllByRole('heading', { level: 2 })
    expect(headings.map(h => h.textContent)).toEqual(['Today', 'Yesterday'])
    const ids = headings.map(h => h.id)
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(2)
  })

  describe('sticky headers', () => {
    // Index 0 heads A (rows 1–50), index 51 heads B (rows 52–101).
    const GROUPED = flattenGroups(
      [
        { label: 'A', rows: rows(50, 'A') },
        { label: 'B', rows: rows(50, 'B') }
      ],
      [],
      keyOf
    )

    const expectSticky = (el: HTMLElement) => {
      expect(el.style.position).toBe('sticky')
      expect(el.style.top).toBe('0px')
      expect(el.style.zIndex).toBe('10')
      expect(el.style.transform).toBe('')
      expect(el).toHaveClass('bg-background')
      expect(el.className).not.toContain('backdrop-blur')
    }

    it('keeps the active header sticky', () => {
      restore = installVirtualLayout({ viewport: 300, item: sized })
      render(<List items={GROUPED} />)
      // At the top, A is the active header.
      expectSticky(item(0)!)
      expect(item(51)).toBeNull()

      // Deep in B, with A's rows and B's header long gone, B stays.
      scrollTo(80 * ROW)
      expect(item(0)).toBeNull()
      expectSticky(item(51)!)
      expect(mounted()[0]).toBe(51)
      expect(mounted().filter(i => i === 51)).toHaveLength(1)
      // Its rows are placed as usual, one after another.
      const top = (i: number) =>
        Number(item(i)!.style.transform.match(/^translateY\((\d+)px\)$/)![1])
      expect(item(80)!.style.position).toBe('absolute')
      expect(top(81) - top(80)).toBe(ROW)
    })

    it('makes the header sticky once its rows reach the top, even while it is in the range', () => {
      restore = installVirtualLayout({ viewport: 300, item: sized })
      render(<List items={GROUPED} />)
      scrollTo(55 * ROW)
      expectSticky(item(51)!)
      expect(mounted().filter(i => i === 51)).toHaveLength(1)
      // A's header, above B's, is no longer sticky (nor mounted).
      expect(item(0)).toBeNull()
    })

    it('places a header that is not at the top like any row', () => {
      restore = installVirtualLayout({ viewport: 300, item: sized })
      render(<List items={GROUPED} />)
      scrollTo(48 * ROW)
      const b = item(51)!
      expect(b.style.position).toBe('absolute')
      expect(b.style.transform).toBe(`translateY(${HEAD + 50 * ROW}px)`)
      expect(b).toHaveClass('bg-background')
    })
  })

  it('counts the content above the list in the scroller (scrollMargin)', () => {
    restore = installVirtualLayout({ viewport: 300, item: sized })
    // The list starts 1000 px down its scroller (a banner, a header).
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.parentElement?.dataset.testid === 'scroller' ? 1000 : 0
      }
    )
    render(<List items={flattenGroups(null, rows(200), keyOf)} />)
    // Scrolled to the list's own row 100: the window is about row 100, not
    // about row 100 + 1000 / 88.
    scrollTo(1000 + 100 * ROW)
    expect(item(100)).not.toBeNull()
    expect(item(91)).not.toBeNull()
    // Items stand from the list's top, not the scroller's.
    expect(item(100)!.style.transform).toBe(`translateY(${100 * ROW}px)`)
    expect(item(100)!.parentElement!.style.height).toBe(`${200 * ROW}px`)
  })

  it('measures the content above it again when the content around it changes size', () => {
    restore = installVirtualLayout({ viewport: 300, item: sized })
    let above = 0
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.parentElement?.dataset.testid === 'scroller' ? above : 0
      }
    )
    render(<List items={flattenGroups(null, rows(200), keyOf)} />)
    const list = item(0)!.parentElement!

    // A banner above the list grows (a larger text size): nothing in the
    // list renders, but the content around it resizes.
    above = 1000
    act(() => resize(list.parentElement!))

    scrollTo(1000 + 100 * ROW)
    expect(item(91)).not.toBeNull()
    expect(item(100)!.style.transform).toBe(`translateY(${100 * ROW}px)`)
  })

  it('reads the content above it on a resize, not on each scroll', () => {
    restore = installVirtualLayout({ viewport: 300, item: sized })
    const offsetTop = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get')
    render(<List items={flattenGroups(null, rows(200), keyOf)} />)
    offsetTop.mockClear()
    for (const n of [20, 60, 120]) scrollTo(n * ROW)
    expect(item(120)).not.toBeNull()
    expect(offsetTop).not.toHaveBeenCalled()
  })

  it('measures each row, and measures again when one changes size (the text size)', () => {
    restore = installVirtualLayout({ viewport: 300, item: sized })
    render(<List items={flattenGroups(null, rows(200), keyOf)} />)
    expect(item(1)!.style.transform).toBe(`translateY(${ROW}px)`)

    // A larger text size: every row grows, and the ResizeObserver says so.
    restore()
    restore = installVirtualLayout({ viewport: 300, item: 100 })
    act(() => {
      for (const el of document.querySelectorAll('[data-index]')) resize(el)
    })
    expect(item(1)!.style.transform).toBe('translateY(100px)')
    expect(item(2)!.style.transform).toBe('translateY(200px)')
  })
})

describe('itemEstimate', () => {
  it('is a row’s and a header’s measured size at the default text size', () => {
    expect(itemEstimate('row', 16)).toBe(88)
    expect(itemEstimate('header', 16)).toBe(38)
  })

  it('grows with the text size', () => {
    expect(itemEstimate('row', 20)).toBe(110)
    expect(itemEstimate('header', 20)).toBe(48)
  })
})

describe('VirtualList estimates', () => {
  const ITEMS = flattenGroups(
    [{ label: 'A', rows: ['a', 'b', 'c'] }],
    [],
    keyOf
  )
  // With no scroller nothing is measured: the box is the estimates' sum.
  const height = () =>
    render(
      <VirtualList
        scroller={{ current: null }}
        items={ITEMS}
        renderRow={row => <p>{row}</p>}
        renderHeader={label => <h2>{label}</h2>}
      />
    ).container.firstElementChild as HTMLElement

  afterEach(() => {
    document.documentElement.style.fontSize = ''
  })

  it('sizes items not yet measured as rows and headers measure', () => {
    expect(height().style.height).toBe(`${38 + 3 * 88}px`)
  })

  it('takes the text size at mount', () => {
    document.documentElement.style.fontSize = '20px'
    expect(height().style.height).toBe(`${48 + 3 * 110}px`)
  })
})

describe('VirtualList keeps each row’s measured height', () => {
  let setRows: (rows: string[]) => void = () => {}
  function Live({ initial }: { initial: string[] }) {
    const [rows, set] = useState(initial)
    setRows = set
    return <List items={flattenGroups(null, rows, keyOf)} />
  }

  it('closes the gap of a deleted tall row with the rows after it', () => {
    restore = installVirtualLayout({ viewport: 300, item: sized })
    const all = Array.from({ length: 100 }, (_, i) =>
      i % 3 === 0 ? `tall ${i}` : `r ${i}`
    )
    render(<Live initial={all} />)
    scrollTo(40 * 100)
    act(() => {
      for (const el of document.querySelectorAll('[data-index]')) resize(el)
    })
    const at = (text: string) => screen.getByText(text).parentElement!
    const top = (text: string) =>
      Number(at(text).style.transform.match(/^translateY\((\d+)px\)$/)![1])
    const was = top('tall 51')
    expect(top('r 52') - was).toBe(150)

    act(() => setRows(all.filter(r => r !== 'tall 51')))

    expect(screen.queryByText('tall 51')).toBeNull()
    expect(top('r 52')).toBe(was)
    expect(at('r 52').dataset.index).toBe('51')
    expect(top('r 53') - top('r 52')).toBe(ROW)
    expect(top('r 55') - top('tall 54')).toBe(150)
  })
})

describe('VirtualList without its scroller', () => {
  it('mounts nothing, and stops asking for its scroller', () => {
    restore = installVirtualLayout({ viewport: 300, item: sized })
    render(
      <VirtualList
        scroller={{ current: null }}
        items={flattenGroups(null, rows(5), keyOf)}
        renderRow={row => <p>{row}</p>}
        renderHeader={label => <h2>{label}</h2>}
      />
    )
    expect(document.querySelectorAll('[data-index]')).toHaveLength(0)
  })
})

describe('sectionHeader', () => {
  it('is a level 2 heading with the id given, and no blur of its own', () => {
    render(sectionHeader('Today', 'h1-id'))
    const heading = screen.getByRole('heading', { level: 2, name: 'Today' })
    expect(heading).toHaveAttribute('id', 'h1-id')
    expect(heading.className).not.toContain('backdrop-blur')
  })
})
