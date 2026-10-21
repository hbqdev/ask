import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { usePullToRefresh } from '@/core/ui/usePullToRefresh'

function Scroller(props: {
  onRefresh: () => Promise<void>
  threshold?: number
  attach?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const opts = props.threshold ? { threshold: props.threshold } : undefined
  const { pull, refreshing } = usePullToRefresh(ref, props.onRefresh, opts)
  return (
    <>
      <div ref={props.attach === false ? undefined : ref} data-testid="list" />
      <output data-testid="pull">{pull}</output>
      <output data-testid="refreshing">{String(refreshing)}</output>
    </>
  )
}

/** A refresh the test settles by hand. */
function deferred() {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(opts: { threshold?: number; attach?: boolean } = {}) {
  const pending = deferred()
  const onRefresh = vi.fn(() => pending.promise)
  render(<Scroller onRefresh={onRefresh} {...opts} />)
  return { onRefresh, pending, list: screen.getByTestId('list') }
}

const pull = () => Number(screen.getByTestId('pull').textContent)
const refreshing = () => screen.getByTestId('refreshing').textContent === 'true'

type Point = { y: number; x?: number; id?: number }
const touch = ({ y, x = 100, id = 0 }: Point) => ({
  identifier: id,
  clientX: x,
  clientY: y
})
const touches = (...points: Point[]) => {
  const list = points.map(touch)
  return { touches: list, changedTouches: list }
}

/** Puts a finger down at the first point and moves it through the rest. Returns whether every move went through (none had its default prevented). */
function pullThrough(list: HTMLElement, points: Point[]) {
  fireEvent.touchStart(list, touches(points[0]))
  let allowed = true
  for (const p of points.slice(1)) {
    allowed = fireEvent.touchMove(list, touches(p)) && allowed
  }
  return allowed
}

function release(list: HTMLElement, at: Point) {
  fireEvent.touchEnd(list, { touches: [], changedTouches: [touch(at)] })
}

describe('usePullToRefresh', () => {
  it('rests at zero, not refreshing', () => {
    setup()
    expect(pull()).toBe(0)
    expect(refreshing()).toBe(false)
  })

  it('follows a pull down at the top, damped, and holds the page still', () => {
    const { list } = setup()
    const allowed = pullThrough(list, [{ y: 100 }, { y: 120 }, { y: 160 }])
    expect(allowed).toBe(false)
    expect(pull()).toBeGreaterThan(0)
    expect(pull()).toBeLessThan(60)
  })

  it('damps more the further it goes, never past twice the threshold', () => {
    const { list } = setup()
    pullThrough(list, [{ y: 0 }, { y: 20 }, { y: 100 }])
    const first = pull()
    fireEvent.touchMove(list, touches({ y: 200 }))
    const second = pull() - first
    expect(second).toBeLessThan(first)
    fireEvent.touchMove(list, touches({ y: 5000 }))
    expect(pull()).toBeLessThan(128)
  })

  it('does not engage when the list is scrolled down', () => {
    const { list, onRefresh } = setup()
    list.scrollTop = 40
    const allowed = pullThrough(list, [{ y: 100 }, { y: 300 }])
    release(list, { y: 300 })
    expect(allowed).toBe(true)
    expect(pull()).toBe(0)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('lets the list scroll when it leaves the top before the pull engages', () => {
    const { list } = setup()
    fireEvent.touchStart(list, touches({ y: 100 }))
    list.scrollTop = 5
    expect(fireEvent.touchMove(list, touches({ y: 140 }))).toBe(true)
    list.scrollTop = 0
    expect(fireEvent.touchMove(list, touches({ y: 180 }))).toBe(true)
    expect(pull()).toBe(0)
  })

  it('does not engage on a drag up or within the slop', () => {
    const { list } = setup()
    expect(pullThrough(list, [{ y: 100 }, { y: 105 }, { y: 40 }])).toBe(true)
    expect(pull()).toBe(0)
  })

  it('leaves a sideways drag (a row swipe) alone', () => {
    const { list } = setup()
    const allowed = pullThrough(list, [
      { y: 100, x: 300 },
      { y: 115, x: 200 },
      { y: 300, x: 200 }
    ])
    expect(allowed).toBe(true)
    expect(pull()).toBe(0)
  })

  it('goes back to zero when the finger returns above where it started', () => {
    const { list } = setup()
    pullThrough(list, [{ y: 100 }, { y: 150 }, { y: 80 }])
    expect(pull()).toBe(0)
  })

  it('snaps back without refreshing when released short of the threshold', () => {
    const { list, onRefresh } = setup()
    pullThrough(list, [{ y: 100 }, { y: 150 }])
    release(list, { y: 150 })
    expect(onRefresh).not.toHaveBeenCalled()
    expect(pull()).toBe(0)
    expect(refreshing()).toBe(false)
  })

  it('refreshes once past the threshold, holding until the refresh settles', async () => {
    const { list, onRefresh, pending } = setup()
    pullThrough(list, [{ y: 100 }, { y: 200 }, { y: 400 }])
    release(list, { y: 400 })
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(refreshing()).toBe(true)
    expect(pull()).toBe(64)

    // A second pull while refreshing is ignored.
    pullThrough(list, [{ y: 100 }, { y: 400 }])
    release(list, { y: 400 })
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(pull()).toBe(64)

    await act(async () => pending.resolve())
    expect(refreshing()).toBe(false)
    expect(pull()).toBe(0)
  })

  it('ends the refresh when it fails, too', async () => {
    const { list, pending } = setup()
    pullThrough(list, [{ y: 100 }, { y: 400 }])
    release(list, { y: 400 })
    await act(async () => pending.reject(new Error('offline')))
    expect(refreshing()).toBe(false)
    expect(pull()).toBe(0)
  })

  it('uses a custom threshold', () => {
    const { list, onRefresh } = setup({ threshold: 20 })
    pullThrough(list, [{ y: 100 }, { y: 150 }])
    release(list, { y: 150 })
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(pull()).toBe(20)
  })

  it('snaps back without refreshing when the touch is cancelled', () => {
    const { list, onRefresh } = setup()
    pullThrough(list, [{ y: 100 }, { y: 400 }])
    fireEvent.touchCancel(list, {
      touches: [],
      changedTouches: [touch({ y: 400 })]
    })
    release(list, { y: 400 })
    expect(onRefresh).not.toHaveBeenCalled()
    expect(pull()).toBe(0)
  })

  it('ignores a second finger and moves or releases of another touch', () => {
    const { list, onRefresh } = setup()
    fireEvent.touchStart(list, touches({ y: 100 }, { y: 100, id: 1 }))
    fireEvent.touchMove(list, touches({ y: 400 }))
    expect(pull()).toBe(0)

    fireEvent.touchStart(list, touches({ y: 100 }))
    fireEvent.touchMove(list, touches({ y: 400, id: 7 }))
    expect(pull()).toBe(0)
    fireEvent.touchMove(list, touches({ y: 400 }))
    fireEvent.touchEnd(list, {
      touches: [],
      changedTouches: [touch({ y: 400, id: 7 })]
    })
    expect(onRefresh).not.toHaveBeenCalled()
    release(list, { y: 400 })
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('ignores moves and releases without a touch down', () => {
    const { list, onRefresh } = setup()
    fireEvent.touchMove(list, touches({ y: 400 }))
    release(list, { y: 400 })
    fireEvent.touchCancel(list, {
      touches: [],
      changedTouches: [touch({ y: 400 })]
    })
    expect(pull()).toBe(0)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('does nothing when the ref is not attached', () => {
    const { onRefresh } = setup({ attach: false })
    expect(pull()).toBe(0)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('stops listening once unmounted', () => {
    const pending = deferred()
    const onRefresh = vi.fn(() => pending.promise)
    const view = render(<Scroller onRefresh={onRefresh} />)
    const list = screen.getByTestId('list')
    view.unmount()
    pullThrough(list, [{ y: 100 }, { y: 400 }])
    release(list, { y: 400 })
    expect(onRefresh).not.toHaveBeenCalled()
  })
})
