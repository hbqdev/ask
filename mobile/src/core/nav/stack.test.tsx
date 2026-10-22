import {
  act,
  createEvent,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
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

/** Stands in for the device's reduced-motion setting, as matchMedia reports it. */
function reducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduce && query === '(prefers-reduced-motion: reduce)'
    }))
  )
}

// The swipe's clock: each pointer event's timeStamp, in ms. swipe() steps it
// by 100 ms an event unless given a time, so drags are slow, never flicks.
let clock = 1000

/** Fires a pointer event at `x` that happened at `t` (100 ms on by default). */
function swipe(
  type: 'pointerDown' | 'pointerMove' | 'pointerUp',
  el: HTMLElement,
  x: number,
  t = clock + 100
) {
  clock = t
  const event = createEvent[type](el, {
    clientX: x,
    clientY: 300,
    pointerId: 1,
    isPrimary: true
  })
  Object.defineProperty(event, 'timeStamp', { value: t })
  fireEvent(el, event)
}

describe('StackView', () => {
  let savedWidth: number

  beforeEach(() => {
    vi.spyOn(history, 'back').mockImplementation(() => {})
    vi.spyOn(history, 'go').mockImplementation(() => {})
    clock = 1000
    reducedMotion(false)
    savedWidth = window.innerWidth
    window.innerWidth = 390
  })

  afterEach(() => {
    window.innerWidth = savedWidth
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
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
    swipe('pointerDown', top, 10)
    swipe('pointerMove', top, 150)
    expect(top.style.transform).toBe('translate3d(140px, 0, 0)')
    expect(top.style.transition).toBe('none')
    swipe('pointerMove', top, 200)
    swipe('pointerUp', top, 200)

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
    swipe('pointerDown', top, 10)
    // 25 px a step: slow, so not a flick.
    swipe('pointerMove', top, 35)
    swipe('pointerMove', top, 60)
    swipe('pointerUp', top, 60)

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

  it('drags the screen below with parallax', () => {
    setupView()
    act(() => stack.push(entry('thread')))
    const top = layer('thread')
    const below = layer('home')
    swipe('pointerDown', top, 10)
    // Half the width across: the screen below is half way in from -30%.
    swipe('pointerMove', top, 205)
    expect(below.style.transition).toBe('none')
    expect(below.style.transform).toBe('translate3d(-15%, 0, 0)')
    swipe('pointerMove', top, 49)
    expect(below.style.transform).toBe(
      `translate3d(${(39 / 390 - 1) * 30}%, 0, 0)`
    )
  })

  it('clears it on cancel and on back', () => {
    setupView()
    act(() => stack.push(entry('thread')))
    const top = layer('thread')
    const below = layer('home')
    swipe('pointerDown', top, 10)
    swipe('pointerMove', top, 35)
    swipe('pointerMove', top, 60)
    expect(below.style.transform).not.toBe('')
    swipe('pointerUp', top, 60)
    expect(stack.screens.map(s => s.key)).toEqual(['home', 'thread'])
    expect(below.style.transform).toBe('')
    expect(below.style.transition).toBe('')

    swipe('pointerDown', top, 10)
    swipe('pointerMove', top, 250)
    expect(below.style.transform).not.toBe('')
    swipe('pointerUp', top, 250)
    expect(stack.screens.map(s => s.key)).toEqual(['home'])
    // The stylesheet's transition settles it from where it was to 0.
    expect(below.style.transform).toBe('')
    expect(below.style.transition).toBe('')
  })

  it('moves only the screen just below the top', () => {
    setupView()
    act(() => stack.push(entry('thread')))
    act(() => stack.push(entry('source')))
    swipe('pointerDown', layer('source'), 10)
    swipe('pointerMove', layer('source'), 205)
    expect(layer('thread').style.transform).toBe('translate3d(-15%, 0, 0)')
    expect(layer('home').style.transform).toBe('')
  })

  it('no parallax under reduced motion', () => {
    reducedMotion(true)
    setupView()
    act(() => stack.push(entry('thread')))
    const top = layer('thread')
    swipe('pointerDown', top, 10)
    swipe('pointerMove', top, 205)
    expect(layer('home').style.transform).toBe('')
    expect(layer('home').style.transition).toBe('')
    // The top screen still follows the finger.
    expect(top.style.transform).toBe('translate3d(195px, 0, 0)')
  })

  it('a fast flick goes back', () => {
    setupView()
    act(() => stack.push(entry('thread')))
    const top = layer('thread')
    swipe('pointerDown', top, 10, 1000)
    swipe('pointerMove', top, 30, 1100)
    // The last 30 px in 10 ms.
    swipe('pointerMove', top, 60, 1110)
    swipe('pointerUp', top, 60, 1110)
    expect(stack.screens.map(s => s.key)).toEqual(['home'])
  })

  it('a stack change mid-drag leaves no layer offset, and the drag goes no further', () => {
    setupView()
    act(() => stack.push(entry('thread')))
    swipe('pointerDown', layer('thread'), 10)
    swipe('pointerMove', layer('thread'), 205)
    expect(layer('home').style.transform).not.toBe('')
    // A deep link pushes a screen while the finger is down.
    act(() => stack.push(entry('linked')))
    for (const key of ['home', 'thread', 'linked']) {
      expect(layer(key).style.transform, key).toBe('')
      expect(layer(key).style.transition, key).toBe('')
    }
    swipe('pointerMove', layer('linked'), 300)
    swipe('pointerUp', layer('linked'), 300)
    expect(layer('linked').style.transform).toBe('')
    expect(stack.screens.map(s => s.key)).toEqual(['home', 'thread', 'linked'])
  })

  it('drags with parallax where matchMedia is missing', () => {
    vi.stubGlobal('matchMedia', undefined)
    setupView()
    act(() => stack.push(entry('thread')))
    swipe('pointerDown', layer('thread'), 10)
    swipe('pointerMove', layer('thread'), 205)
    expect(layer('home').style.transform).toBe('translate3d(-15%, 0, 0)')
  })

  it('reads the reduced-motion setting once a drag', () => {
    setupView()
    act(() => stack.push(entry('thread')))
    const top = layer('thread')
    swipe('pointerDown', top, 10)
    swipe('pointerMove', top, 60)
    swipe('pointerMove', top, 100)
    swipe('pointerMove', top, 120)
    expect(window.matchMedia).toHaveBeenCalledTimes(1)
    // Short of a third: it snaps back.
    swipe('pointerUp', top, 120)
    expect(stack.screens.map(s => s.key)).toEqual(['home', 'thread'])
    // The next drag reads it again.
    swipe('pointerDown', top, 10)
    swipe('pointerMove', top, 60)
    expect(window.matchMedia).toHaveBeenCalledTimes(2)
  })
})

// --- Focus --------------------------------------------------------------------

describe('StackView focus', () => {
  beforeEach(() => {
    vi.spyOn(history, 'back').mockImplementation(() => {})
    vi.spyOn(history, 'go').mockImplementation(() => {})
    clock = 1000
    reducedMotion(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  function Home() {
    return (
      <main>
        <h1>Home</h1>
        <button type="button">open</button>
      </main>
    )
  }

  const titled = (key: string, title: string) => entry(key, <h1>{title}</h1>)

  function openFromHome() {
    setupView(entry('home', <Home />))
    const opener = screen.getByRole('button', { name: 'open' })
    opener.focus()
    return opener
  }

  it('focuses the pushed screen’s heading', () => {
    openFromHome()
    act(() => stack.push(titled('thread', 'Thread')))
    expect(screen.getByText('Thread')).toHaveFocus()
    expect(screen.getByText('Thread')).toHaveAttribute('tabindex', '-1')
  })

  it('leaves focus a pushed screen already took', () => {
    function Field() {
      const ref = useRef<HTMLInputElement>(null)
      useEffect(() => ref.current!.focus(), [])
      return (
        <>
          <h1>Note</h1>
          <input ref={ref} aria-label="Body" />
        </>
      )
    }
    openFromHome()
    act(() => stack.push(entry('note', <Field />)))
    expect(screen.getByLabelText('Body')).toHaveFocus()
  })

  it('returns focus to the opener on pop', () => {
    const opener = openFromHome()
    act(() => stack.push(titled('thread', 'Thread')))
    expect(opener).not.toHaveFocus()
    const focus = vi.spyOn(opener, 'focus')
    act(() => stack.pop())
    expect(opener).toHaveFocus()
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('returns focus to the opener after a swipe back', () => {
    const opener = openFromHome()
    act(() => stack.push(titled('thread', 'Thread')))
    expect(opener).not.toHaveFocus()
    const top = layer('thread')
    // Past a third of jsdom's 1024 px window.
    swipe('pointerDown', top, 10)
    swipe('pointerMove', top, 400)
    swipe('pointerUp', top, 400)
    expect(stack.screens.map(s => s.key)).toEqual(['home'])
    expect(opener).toHaveFocus()
  })

  it('returns focus through a stack of screens, one opener each', () => {
    const opener = openFromHome()
    act(() =>
      stack.push(
        entry(
          'thread',
          <>
            <h1>Thread</h1>
            <button type="button">source</button>
          </>
        )
      )
    )
    const source = screen.getByText('source')
    source.focus()
    act(() => stack.push(titled('source', 'Source')))
    expect(screen.getByText('Source')).toHaveFocus()
    act(() => stack.pop())
    expect(source).toHaveFocus()
    act(() => stack.pop())
    expect(opener).toHaveFocus()
  })

  it('history going back several screens at once returns to the lowest opener', () => {
    const opener = openFromHome()
    act(() =>
      stack.push(
        entry(
          'thread',
          <>
            <h1>Thread</h1>
            <button type="button">source</button>
          </>
        )
      )
    )
    screen.getByText('source').focus()
    act(() => stack.push(titled('source', 'Source')))
    act(() => {
      window.dispatchEvent(
        new PopStateEvent('popstate', { state: { askStackDepth: 0 } })
      )
    })
    expect(stack.screens.map(s => s.key)).toEqual(['home'])
    expect(opener).toHaveFocus()
  })

  it('a pop back to a text-field opener focuses the heading, not the field (no keyboard)', () => {
    setupView(
      entry(
        'home',
        <main>
          <h1>Home</h1>
          <textarea aria-label="Ask" />
        </main>
      )
    )
    // Return in the composer sends: the field still has focus at the push.
    const field = screen.getByLabelText('Ask')
    field.focus()
    act(() => stack.push(titled('thread', 'Thread')))
    act(() => stack.pop())
    expect(field).not.toHaveFocus()
    expect(screen.getByText('Home')).toHaveFocus()
  })

  it('an opener in a hidden part gets no focus; the heading does', () => {
    const opener = openFromHome()
    act(() => stack.push(titled('thread', 'Thread')))
    // Its part of the screen was hidden meanwhile (another tab shown).
    opener.hidden = true
    act(() => stack.pop())
    expect(opener).not.toHaveFocus()
    expect(screen.getByText('Home')).toHaveFocus()
  })

  it('a pop keeps focus something on the shown screen already took', () => {
    function Draft() {
      const shown = useScreenActive()
      const ref = useRef<HTMLInputElement>(null)
      const covered = useRef(false)
      useEffect(() => {
        if (!shown) covered.current = true
        else if (covered.current) ref.current!.focus()
      }, [shown])
      return <input ref={ref} aria-label="Draft" />
    }
    setupView(
      entry(
        'home',
        <main>
          <h1>Home</h1>
          <button type="button">open</button>
          <Draft />
        </main>
      )
    )
    screen.getByText('open').focus()
    act(() => stack.push(titled('thread', 'Thread')))
    act(() => stack.pop())
    expect(screen.getByLabelText('Draft')).toHaveFocus()
  })

  it('falls back to the heading when the opener is gone', () => {
    setupView(entry('home', <Home />))
    const gone = document.createElement('button')
    document.body.append(gone)
    gone.focus()
    act(() => stack.push(titled('thread', 'Thread')))
    gone.remove()
    act(() => stack.pop())
    expect(screen.getByText('Home')).toHaveFocus()
  })

  it('falls back to the heading when nothing had focus at the push', () => {
    setupView(entry('home', <Home />))
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)
    act(() => stack.push(titled('thread', 'Thread')))
    ;(document.activeElement as HTMLElement).blur()
    act(() => stack.pop())
    expect(screen.getByText('Home')).toHaveFocus()
  })

  it('focuses a replacing screen’s heading, and its pop returns to the first opener', () => {
    const opener = openFromHome()
    act(() => stack.push(titled('a', 'A')))
    act(() => stack.replace(titled('b', 'B')))
    expect(screen.getByText('B')).toHaveFocus()
    act(() => stack.pop())
    expect(opener).toHaveFocus()
  })

  it('focuses the fresh root’s heading on a reset', () => {
    openFromHome()
    act(() => stack.push(titled('a', 'A')))
    act(() => stack.reset(titled('fresh', 'Fresh')))
    expect(screen.getByText('Fresh')).toHaveFocus()
  })

  it('moves no focus on first mount', () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    setupView(entry('home', <Home />))
    expect(outside).toHaveFocus()
    expect(screen.getByText('Home')).not.toHaveAttribute('tabindex')
  })
})
