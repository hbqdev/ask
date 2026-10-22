import { defaultRangeExtractor } from '@tanstack/react-virtual'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  flattenGroups,
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

const ROW = 72

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
    restore = installVirtualLayout({ viewport: 300, item: ROW })
    render(<List items={flattenGroups(null, rows(200), keyOf)} />)
    expect(screen.getByText('Row 0')).toBeInTheDocument()
    expect(screen.queryByText('Row 199')).toBeNull()
    expect(document.querySelectorAll('[data-index]').length).toBeLessThan(30)
    expect(
      document.querySelectorAll('[data-index]').length
    ).toBeGreaterThanOrEqual(Math.ceil(300 / ROW))
  })

  it('holds the whole list’s height, so the scroller scrolls it all', () => {
    restore = installVirtualLayout({ viewport: 300, item: ROW })
    render(<List items={flattenGroups(null, rows(200), keyOf)} />)
    expect(item(0)!.parentElement!.style.height).toBe(`${200 * ROW}px`)
  })

  it('mounts the rows scrolled to and lets go of those scrolled past', () => {
    restore = installVirtualLayout({ viewport: 300, item: ROW })
    render(<List items={flattenGroups(null, rows(200), keyOf)} />)
    scrollTo(150 * ROW)
    expect(screen.getByText('Row 150')).toBeInTheDocument()
    expect(screen.queryByText('Row 0')).toBeNull()
    expect(item(150)!.style.transform).toBe(`translateY(${150 * ROW}px)`)
    expect(item(150)!.style.position).toBe('absolute')
  })

  it('passes each row its separator, and marks every item with its index', () => {
    restore = installVirtualLayout({ viewport: 300, item: ROW })
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
    restore = installVirtualLayout({ viewport: 300, item: ROW })
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
      restore = installVirtualLayout({ viewport: 300, item: ROW })
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
      restore = installVirtualLayout({ viewport: 300, item: ROW })
      render(<List items={GROUPED} />)
      scrollTo(55 * ROW)
      expectSticky(item(51)!)
      expect(mounted().filter(i => i === 51)).toHaveLength(1)
      // A's header, above B's, is no longer sticky (nor mounted).
      expect(item(0)).toBeNull()
    })

    it('places a header that is not at the top like any row', () => {
      restore = installVirtualLayout({ viewport: 300, item: ROW })
      render(<List items={GROUPED} />)
      scrollTo(48 * ROW)
      const b = item(51)!
      expect(b.style.position).toBe('absolute')
      expect(b.style.transform).toBe(`translateY(${51 * ROW}px)`)
      expect(b).toHaveClass('bg-background')
    })
  })

  it('counts the content above the list in the scroller (scrollMargin)', () => {
    restore = installVirtualLayout({ viewport: 300, item: ROW })
    // The list starts 1000 px down its scroller (a banner, a header).
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.querySelector(':scope > [data-index]') ? 1000 : 0
      }
    )
    render(<List items={flattenGroups(null, rows(200), keyOf)} />)
    // Scrolled to the list's own row 100: the window is about row 100, not
    // about row 100 + 1000 / 72.
    scrollTo(1000 + 100 * ROW)
    expect(item(100)).not.toBeNull()
    expect(item(91)).not.toBeNull()
    // Items stand from the list's top, not the scroller's.
    expect(item(100)!.style.transform).toBe(`translateY(${100 * ROW}px)`)
    expect(item(100)!.parentElement!.style.height).toBe(`${200 * ROW}px`)
  })

  it('measures each row, and measures again when one changes size (the text size)', () => {
    restore = installVirtualLayout({ viewport: 300, item: ROW })
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

describe('VirtualList without its scroller', () => {
  it('mounts nothing, and stops asking for its scroller', () => {
    restore = installVirtualLayout({ viewport: 300, item: ROW })
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
