import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  StackProvider,
  StackView,
  useScreenActive,
  useStack,
  type ScreenEntry
} from '@/core/nav/stack'

function entry(key: string, content: ReactNode = key): ScreenEntry {
  return { key, render: () => content }
}

const home = entry('home')

function setupHook(root: ScreenEntry = home) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StackProvider root={root}>{children}</StackProvider>
  )
  return renderHook(() => useStack(), { wrapper })
}

function keys(screens: ScreenEntry[]): string[] {
  return screens.map(s => s.key)
}

describe('useStack', () => {
  let back: ReturnType<typeof vi.spyOn>
  let go: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Most tests drive the stack directly; keep jsdom's real history from
    // firing late popstate events into the next test.
    back = vi.spyOn(history, 'back').mockImplementation(() => {})
    go = vi.spyOn(history, 'go').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts with the root screen', () => {
    const { result } = setupHook()
    expect(keys(result.current.screens)).toEqual(['home'])
  })

  it('pushes a screen and a history entry', () => {
    const pushState = vi.spyOn(history, 'pushState')
    const { result } = setupHook()
    act(() => result.current.push(entry('thread')))
    expect(keys(result.current.screens)).toEqual(['home', 'thread'])
    expect(pushState).toHaveBeenCalledTimes(1)
    expect(history.state).toEqual({ askStackDepth: 1 })
  })

  it('pops the top screen and steps history back', () => {
    const { result } = setupHook()
    act(() => result.current.push(entry('thread')))
    act(() => result.current.pop())
    expect(keys(result.current.screens)).toEqual(['home'])
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('does nothing when popping the root', () => {
    const { result } = setupHook()
    const before = result.current.screens
    act(() => result.current.pop())
    expect(result.current.screens).toBe(before)
    expect(back).not.toHaveBeenCalled()
  })

  it('replaces the top screen without touching history', () => {
    const pushState = vi.spyOn(history, 'pushState')
    const { result } = setupHook()
    act(() => result.current.push(entry('a')))
    act(() => result.current.replace(entry('b')))
    expect(keys(result.current.screens)).toEqual(['home', 'b'])
    expect(pushState).toHaveBeenCalledTimes(1)
    expect(back).not.toHaveBeenCalled()
  })

  it('resets to a single screen and unwinds its history entries', () => {
    const { result } = setupHook()
    act(() => result.current.push(entry('a')))
    act(() => result.current.push(entry('b')))
    act(() => result.current.reset(entry('fresh')))
    expect(keys(result.current.screens)).toEqual(['fresh'])
    expect(go).toHaveBeenCalledWith(-2)
  })

  it('resets from the root without touching history', () => {
    const { result } = setupHook()
    act(() => result.current.reset(entry('fresh')))
    expect(keys(result.current.screens)).toEqual(['fresh'])
    expect(go).not.toHaveBeenCalled()
  })

  it('pops on popstate to the depth history went back to', () => {
    const { result } = setupHook()
    act(() => result.current.push(entry('a')))
    act(() => result.current.push(entry('b')))
    act(() => {
      window.dispatchEvent(
        new PopStateEvent('popstate', { state: { askStackDepth: 1 } })
      )
    })
    expect(keys(result.current.screens)).toEqual(['home', 'a'])
    // A popstate with no stack state is the entry before the first push.
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    })
    expect(keys(result.current.screens)).toEqual(['home'])
  })

  it('ignores a popstate that does not shorten the stack', () => {
    const { result } = setupHook()
    act(() => result.current.push(entry('a')))
    const before = result.current.screens
    act(() => {
      window.dispatchEvent(
        new PopStateEvent('popstate', { state: { askStackDepth: 3 } })
      )
    })
    expect(result.current.screens).toBe(before)
  })

  it('marks the current history entry as the root on mount', () => {
    history.replaceState({ askStackDepth: 4, other: true }, '')
    setupHook()
    expect(history.state).toEqual({ askStackDepth: 0, other: true })
  })

  it('stops listening for popstate when unmounted', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = setupHook()
    unmount()
    expect(remove).toHaveBeenCalledWith('popstate', expect.any(Function))
  })

  it('throws when used outside a StackProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useStack())).toThrow(
      'useStack must be used inside a StackProvider'
    )
  })
})

describe('useStack with the browser history', () => {
  it('pops when the browser goes back', async () => {
    const { result } = setupHook()
    act(() => result.current.push(entry('a')))
    act(() => result.current.push(entry('b')))
    act(() => history.back())
    await waitFor(() =>
      expect(keys(result.current.screens)).toEqual(['home', 'a'])
    )
  })

  it('stays in step with history after a programmatic pop', async () => {
    const { result } = setupHook()
    act(() => result.current.push(entry('a')))
    act(() => result.current.pop())
    expect(keys(result.current.screens)).toEqual(['home'])
    await waitFor(() => expect(history.state?.askStackDepth).toBe(0))
    expect(keys(result.current.screens)).toEqual(['home'])
  })
})

// --- StackView ---------------------------------------------------------------

/** A screen with a counter, to show a screen keeps its state under others. */
function Counter({ label }: { label: string }) {
  const [n, setN] = useState(0)
  return (
    <button type="button" onClick={() => setN(n + 1)}>
      {label} {n}
    </button>
  )
}

let stack: ReturnType<typeof useStack>

function Grab() {
  stack = useStack()
  return null
}

function setupView(
  root: ScreenEntry = entry('home', <Counter label="home" />)
) {
  render(
    <StackProvider root={root}>
      <Grab />
      <StackView />
    </StackProvider>
  )
}

function layer(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-stack-key="${key}"]`)
  if (!el) throw new Error(`no layer ${key}`)
  return el
}

function hasLayer(key: string): boolean {
  return document.querySelector(`[data-stack-key="${key}"]`) !== null
}

describe('StackView', () => {
  let savedWidth: number

  beforeEach(() => {
    vi.spyOn(history, 'back').mockImplementation(() => {})
    vi.spyOn(history, 'go').mockImplementation(() => {})
    savedWidth = window.innerWidth
    window.innerWidth = 390
  })

  afterEach(() => {
    window.innerWidth = savedWidth
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows the root screen without an entrance animation', () => {
    setupView()
    expect(screen.getByRole('button', { name: 'home 0' })).toBeInTheDocument()
    expect(layer('home')).not.toHaveClass('stack-enter')
  })

  it('slides a pushed screen in over the one below, which keeps its state', () => {
    setupView()
    fireEvent.click(screen.getByRole('button', { name: 'home 0' }))
    act(() => stack.push(entry('thread', <Counter label="thread" />)))

    expect(layer('thread')).toHaveClass('stack-layer', 'stack-enter')
    expect(layer('home')).toHaveAttribute('inert')
    expect(layer('home')).toHaveAttribute('aria-hidden', 'true')
    expect(layer('thread')).not.toHaveAttribute('inert')

    act(() => stack.pop())
    expect(screen.getByRole('button', { name: 'home 1' })).toBeInTheDocument()
    expect(layer('home')).not.toHaveAttribute('inert')
  })

  it('tells each screen whether it is the top one', () => {
    function Probe({ label }: { label: string }) {
      return <p>{`${label} ${useScreenActive() ? 'on top' : 'covered'}`}</p>
    }
    setupView(entry('home', <Probe label="home" />))
    expect(screen.getByText('home on top')).toBeInTheDocument()

    act(() => stack.push(entry('thread', <Probe label="thread" />)))
    expect(screen.getByText('home covered')).toBeInTheDocument()
    expect(screen.getByText('thread on top')).toBeInTheDocument()

    // A popped screen is no longer on top while it slides out.
    act(() => stack.pop())
    expect(screen.getByText('home on top')).toBeInTheDocument()
    expect(screen.getByText('thread covered')).toBeInTheDocument()
  })

  it('a screen outside a stack counts as on top', () => {
    function Probe() {
      return <p>{useScreenActive() ? 'on top' : 'covered'}</p>
    }
    render(<Probe />)
    expect(screen.getByText('on top')).toBeInTheDocument()
  })

  it('stacks each screen above the ones below it, by depth', () => {
    setupView()
    act(() => stack.push(entry('thread')))
    act(() => stack.push(entry('source')))
    const z = ['home', 'thread', 'source'].map(k =>
      Number(layer(k).style.zIndex)
    )
    expect(z).toEqual([1, 2, 3])

    // A popped screen keeps the top layer while it slides out.
    act(() => stack.pop())
    expect(Number(layer('source').style.zIndex)).toBe(3)
    expect(Number(layer('thread').style.zIndex)).toBe(2)
  })

  it('slides a popped screen out, then removes it', () => {
    setupView()
    act(() => stack.push(entry('thread')))
    act(() => stack.pop())
    const leaving = layer('thread')
    expect(leaving).toHaveClass('stack-leave')
    expect(leaving).toHaveAttribute('inert')

    // A transition inside the screen is not the slide finishing.
    const inner = document.createElement('span')
    leaving.append(inner)
    fireEvent.transitionEnd(inner)
    expect(hasLayer('thread')).toBe(true)

    fireEvent.transitionEnd(leaving)
    expect(hasLayer('thread')).toBe(false)
  })

  it('removes a popped screen even if its transition never ends', () => {
    vi.useFakeTimers()
    setupView()
    act(() => stack.push(entry('thread')))
    act(() => stack.pop())
    expect(hasLayer('thread')).toBe(true)
    act(() => vi.advanceTimersByTime(400))
    expect(hasLayer('thread')).toBe(false)
  })

  it('swaps a replaced screen without animating', () => {
    setupView()
    act(() => stack.push(entry('a')))
    act(() => stack.replace(entry('b')))
    expect(hasLayer('a')).toBe(false)
    expect(layer('b')).not.toHaveClass('stack-enter')
    expect(layer('b')).not.toHaveClass('stack-leave')
  })

  it('slides the old top out on a reset', () => {
    setupView()
    act(() => stack.push(entry('a')))
    act(() => stack.push(entry('b')))
    act(() => stack.reset(entry('fresh')))
    expect(hasLayer('a')).toBe(false)
    expect(layer('b')).toHaveClass('stack-leave')
    expect(layer('fresh')).not.toHaveAttribute('inert')
  })

  it('goes back on an edge swipe, following the finger', () => {
    setupView()
    act(() => stack.push(entry('thread')))
    const top = layer('thread')
    const at = (x: number) => ({
      clientX: x,
      clientY: 300,
      pointerId: 1,
      isPrimary: true
    })
    fireEvent.pointerDown(top, at(10))
    fireEvent.pointerMove(top, at(150))
    expect(top.style.transform).toBe('translate3d(140px, 0, 0)')
    expect(top.style.transition).toBe('none')
    fireEvent.pointerMove(top, at(200))
    fireEvent.pointerUp(top, at(200))

    expect(stack.screens.map(s => s.key)).toEqual(['home'])
    expect(top).toHaveClass('stack-leave')
    // The slide out continues from where the finger let go.
    expect(top.style.transition).toBe('')
    expect(top.style.transform).toBe('translate3d(190px, 0, 0)')
  })

  it('snaps back after a short swipe', () => {
    setupView()
    act(() => stack.push(entry('thread')))
    const top = layer('thread')
    const at = (x: number) => ({
      clientX: x,
      clientY: 300,
      pointerId: 1,
      isPrimary: true
    })
    fireEvent.pointerDown(top, at(10))
    fireEvent.pointerMove(top, at(60))
    fireEvent.pointerUp(top, at(60))

    expect(stack.screens.map(s => s.key)).toEqual(['home', 'thread'])
    expect(top.style.transform).toBe('')
    expect(top.style.transition).toBe('')
  })

  it('does not swipe back from the root', () => {
    setupView()
    const root = layer('home')
    fireEvent.pointerDown(root, {
      clientX: 10,
      clientY: 300,
      pointerId: 1,
      isPrimary: true
    })
    fireEvent.pointerMove(root, {
      clientX: 200,
      clientY: 300,
      pointerId: 1,
      isPrimary: true
    })
    expect(root.style.transform).toBe('')
  })
})
