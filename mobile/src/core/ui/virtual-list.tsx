// A long list that mounts only what is on screen (and a few rows either
// side), so a Library of hundreds of chats costs the same as one of twenty.
// The list's items are its rows and, between date groups, their headers. The
// header of the rows at the top stays stuck there (as in iOS), opaque; every
// other item stands at its place in a box as tall as the whole list, so the
// scroller scrolls it all and whatever follows the list (the end that loads
// the next page) sits after it. Rows are measured as they mount and again
// whenever they change size (a new text size), so heights may vary.
//
// No list role: VoiceOver reads the rows in order and finds the headers, which
// stay headings, with its rotor.

import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range
} from '@tanstack/react-virtual'
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'

export type VirtualItem<T> =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'row'; key: string; row: T; separator: boolean }

// What a header and a (two-line) row measure at the default text size, 16 px
// (the Library's; a note row is as tall).
const ESTIMATES = { header: 38, row: 88 }

/**
 * The size to assume for an item until it is measured: its size at the
 * default text size, scaled to the text size `rootPx` (the root font size,
 * which follows the iOS text size).
 */
export function itemEstimate(
  kind: VirtualItem<unknown>['kind'],
  rootPx: number
): number {
  return Math.round((ESTIMATES[kind] * rootPx) / 16)
}

/** The root font size in px (16 when it cannot be read). */
const rootFontPx = () =>
  parseFloat(getComputedStyle(document.documentElement).fontSize) || 16

/** Items mounted beyond each end of the window. */
const OVERSCAN = 10

/**
 * The items of a grouped list: each group's header (`h:<label>`), then its
 * rows (`r:<key>`), each but the last of its group drawing a separator.
 * Without groups (null), the rows alone, each but the last separated.
 */
export function flattenGroups<T>(
  groups: { label: string; rows: T[] }[] | null,
  rows: T[],
  keyOf: (row: T) => string
): VirtualItem<T>[] {
  const rowItems = (list: T[]): VirtualItem<T>[] =>
    list.map((row, i) => ({
      kind: 'row',
      key: `r:${keyOf(row)}`,
      row,
      separator: i < list.length - 1
    }))
  if (groups === null) return rowItems(rows)
  return groups.flatMap(group => [
    { kind: 'header', key: `h:${group.label}`, label: group.label } as const,
    ...rowItems(group.rows)
  ])
}

/** The last of `headers` (ascending indexes) at or before `index`. */
function headerAt(headers: number[], index: number): number | undefined {
  for (let i = headers.length - 1; i >= 0; i--) {
    if (headers[i] <= index) return headers[i]
  }
  return undefined
}

/**
 * The indexes to mount: the window (with its overscan), and before it the
 * header of the rows at its top, which is stuck there.
 */
export function stickyRangeExtractor(
  headerIndexes: number[]
): (range: Range) => number[] {
  return range => {
    const indexes = defaultRangeExtractor(range)
    const active = headerAt(headerIndexes, range.startIndex)
    return active === undefined || indexes.includes(active)
      ? indexes
      : [active, ...indexes]
  }
}

/**
 * How far down its scroller `el` starts. Its offset parents lead up to the
 * scroller, which must be positioned (PullScroller's is). Transforms (a pull
 * in progress) do not count.
 */
function offsetWithin(el: HTMLElement, scroller: HTMLElement): number {
  let top = 0
  for (
    let node: HTMLElement | null = el;
    node && node !== scroller;
    node = node.offsetParent as HTMLElement | null
  ) {
    top += node.offsetTop
  }
  return top
}

const STICKY = { position: 'sticky', top: 0, zIndex: 10 } as const

export type VirtualListProps<T> = {
  /** The element that scrolls the list. */
  scroller: RefObject<HTMLElement | null>
  items: VirtualItem<T>[]
  renderRow(row: T, separator: boolean): ReactNode
  /** A header: a heading, given its id. */
  renderHeader(label: string, id: string): ReactNode
}

export function VirtualList<T>({
  scroller,
  items,
  renderRow,
  renderHeader
}: VirtualListProps<T>) {
  const list = useRef<HTMLDivElement>(null)
  const idPrefix = useId()
  // How far down the scroller the list starts (what is above it: a banner).
  const [margin, setMargin] = useState(0)
  // The text size at mount; measuring corrects any later change.
  const [rootPx] = useState(rootFontPx)

  const headers = useMemo(
    () => items.flatMap((item, i) => (item.kind === 'header' ? [i] : [])),
    [items]
  )
  const rangeExtractor = useMemo(() => stickyRangeExtractor(headers), [headers])
  const estimateSize = useCallback(
    (i: number) => itemEstimate(items[i].kind, rootPx),
    [items, rootPx]
  )
  const getItemKey = useCallback((i: number) => items[i].key, [items])

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize,
    overscan: OVERSCAN,
    getItemKey,
    rangeExtractor,
    scrollMargin: margin
  })

  // Mounted with its scroller, the list runs its layout effects before the
  // scroller (an ancestor) has its ref: the virtualizer finds no element to
  // watch. One more render, before paint, finds it.
  const [tries, retry] = useReducer((n: number) => n + 1, 0)

  // Measured at mount, then whenever the content around the list changes
  // size (a banner above it comes, goes or reflows), not on every render: a
  // read of offsetTop forces a layout.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) {
      if (tries === 0) retry()
      return
    }
    const node = list.current!
    const measure = () => setMargin(offsetWithin(node, el))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(
      (node.offsetParent as HTMLElement | null) ?? node.parentElement!
    )
    return () => observer.disconnect()
  }, [scroller, tries])

  const virtualItems = virtualizer.getVirtualItems()
  const range = virtualizer.range
  const active = range ? headerAt(headers, range.startIndex) : undefined

  return (
    <div
      ref={list}
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualItems.map(v => {
        const item = items[v.index]
        return (
          <div
            key={v.key}
            data-index={v.index}
            ref={virtualizer.measureElement}
            className={item.kind === 'header' ? 'bg-background' : undefined}
            style={
              v.index === active
                ? STICKY
                : {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${v.start - margin}px)`
                  }
            }
          >
            {item.kind === 'header'
              ? renderHeader(
                  item.label,
                  `${idPrefix}-section-${headers.indexOf(v.index)}`
                )
              : renderRow(item.row, item.separator)}
          </div>
        )
      })}
    </div>
  )
}

/**
 * A date section's header in a windowed list (renderHeader): a heading, for
 * VoiceOver's rotor. The list paints it opaque when it sticks.
 */
export function sectionHeader(label: string, id: string): ReactNode {
  return (
    <h2
      id={id}
      className="px-6 pt-4 pb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
    >
      {label}
    </h2>
  )
}
