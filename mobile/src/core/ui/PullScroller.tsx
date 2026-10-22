// A screen's scrolling list with pull to refresh (usePullToRefresh): the list
// follows the finger down, a spinner fades in above it, and a release far
// enough refreshes, the spinner turning until the refresh settles.

import type { ReactNode, RefObject } from 'react'

import { usePullToRefresh } from '@/core/ui/usePullToRefresh'

/**
 * The scroller, with pull to refresh. The pull is state here, not in the
 * screen: each touchmove renders only this wrapper and the indicator, while
 * `children` (the same element as before) is not rendered again. The screen
 * keeps this mounted for its whole life, as the pull hook binds to the
 * scroller once. `testId` names the scroller (`<testId>-scroll`) and the
 * content that moves (`<testId>-content`). A status-bar tap scrolls it to
 * the top when its screen is in front (`data-scroll-root`).
 */
export function PullScroller({
  scroller,
  onRefresh,
  testId,
  children
}: {
  scroller: RefObject<HTMLDivElement | null>
  onRefresh: () => Promise<void>
  testId: string
  children: ReactNode
}) {
  const { pull, refreshing } = usePullToRefresh(scroller, onRefresh)
  // Back at rest (or held while refreshing), the list settles with a
  // transition; under the finger it follows without one.
  const settling = pull === 0 || refreshing
  return (
    <div
      ref={scroller}
      data-testid={`${testId}-scroll`}
      // A status-bar tap scrolls it to the top (core/nav/scroll-to-top).
      data-scroll-root
      className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <PullIndicator pull={pull} refreshing={refreshing} />
      <div
        data-testid={`${testId}-content`}
        className={`relative bg-background pb-6 ${settling ? 'pull-settle' : ''}`}
        style={pull ? { transform: `translate3d(0, ${pull}px, 0)` } : undefined}
      >
        {children}
      </div>
    </div>
  )
}

function PullIndicator({
  pull,
  refreshing
}: {
  pull: number
  refreshing: boolean
}) {
  return (
    <div
      aria-hidden={!refreshing}
      className="absolute inset-x-0 top-0 flex h-16 items-center justify-center"
      style={{ opacity: refreshing ? 1 : Math.min(1, pull / 64) }}
    >
      <span
        role={refreshing ? 'status' : undefined}
        aria-label={refreshing ? 'Refreshing' : undefined}
        className={`size-6 rounded-full border-2 border-foreground/20 border-t-foreground/70 ${
          refreshing ? 'animate-spin' : ''
        }`}
        style={refreshing ? undefined : { transform: `rotate(${pull * 4}deg)` }}
      />
    </div>
  )
}
