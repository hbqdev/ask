import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type TransitionEvent
} from 'react'

import { useEdgeSwipe } from '@/core/nav/use-edge-swipe'

export type ScreenEntry = { key: string; render: () => ReactNode }

export type Stack = {
  screens: ScreenEntry[]
  push(screen: ScreenEntry): void
  pop(): void
  replace(screen: ScreenEntry): void
  reset(screen: ScreenEntry): void
}

const StackContext = createContext<Stack | null>(null)

// Each history entry the stack pushes records the depth it was pushed at, so a
// popstate (the back gesture, or a programmatic back) says how deep to be.
const DEPTH_KEY = 'askStackDepth'

function depthOf(state: unknown): number {
  const depth = (state as Record<string, unknown> | null)?.[DEPTH_KEY]
  return typeof depth === 'number' ? depth : 0
}

/**
 * A navigation stack: the root screen, with screens pushed over it. Each push
 * adds a browser history entry, so going back in history pops.
 */
export function StackProvider({
  root,
  children
}: {
  root: ScreenEntry
  children: ReactNode
}) {
  const [screens, setScreens] = useState<ScreenEntry[]>(() => [root])
  // The source of truth for the actions, so two in one tick see each other.
  const current = useRef(screens)

  const commit = useCallback((next: ScreenEntry[]) => {
    current.current = next
    setScreens(next)
  }, [])

  useEffect(() => {
    // This entry is the root, whatever depth a previous run left on it.
    history.replaceState({ ...history.state, [DEPTH_KEY]: 0 }, '')
    const onPopState = (e: PopStateEvent) => {
      const depth = depthOf(e.state)
      if (current.current.length > depth + 1) {
        commit(current.current.slice(0, depth + 1))
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [commit])

  const push = useCallback(
    (screen: ScreenEntry) => {
      const next = [...current.current, screen]
      commit(next)
      history.pushState({ [DEPTH_KEY]: next.length - 1 }, '')
    },
    [commit]
  )

  const pop = useCallback(() => {
    if (current.current.length <= 1) return
    commit(current.current.slice(0, -1))
    // The popstate this causes finds the stack already at that depth.
    history.back()
  }, [commit])

  const replace = useCallback(
    (screen: ScreenEntry) => {
      commit([...current.current.slice(0, -1), screen])
    },
    [commit]
  )

  const reset = useCallback(
    (screen: ScreenEntry) => {
      const pushed = current.current.length - 1
      commit([screen])
      if (pushed > 0) history.go(-pushed)
    },
    [commit]
  )

  const value = useMemo(
    () => ({ screens, push, pop, replace, reset }),
    [screens, push, pop, replace, reset]
  )
  return <StackContext.Provider value={value}>{children}</StackContext.Provider>
}

const ScreenActiveContext = createContext(true)

/**
 * Whether this screen is the top of its stack, the one shown (true outside a
 * stack). Covered screens stay mounted, so this is how their content knows it
 * was covered or shown again.
 */
export function useScreenActive(): boolean {
  return useContext(ScreenActiveContext)
}

export function useStack(): Stack {
  const stack = useContext(StackContext)
  if (!stack) throw new Error('useStack must be used inside a StackProvider')
  return stack
}

// --- StackView ---------------------------------------------------------------

// How long to wait for a popped screen's slide before removing it anyway
// (the slide is 280ms; see styles.css).
const LEAVE_FALLBACK_MS = 400

type Motion = {
  /** The screens this motion was worked out for. */
  screens: ScreenEntry[]
  /** The key of a screen sliding in, if one was just pushed. */
  entering: string | null
  /** A screen that was just popped, still on screen while it slides out. */
  leaving: ScreenEntry | null
}

function nextMotion(prev: ScreenEntry[], screens: ScreenEntry[]): Motion {
  const top = screens[screens.length - 1]
  if (screens.length > prev.length) {
    return { screens, entering: top.key, leaving: null }
  }
  const prevTop = prev[prev.length - 1]
  const popped =
    screens.length < prev.length && !screens.some(s => s.key === prevTop.key)
  return { screens, entering: null, leaving: popped ? prevTop : null }
}

// Entries are stable, so a screen only re-renders for its own reasons, not on
// every push or pop around it.
const ScreenContent = memo(function ScreenContent({
  entry
}: {
  entry: ScreenEntry
}) {
  return entry.render()
})

/**
 * Renders the stack: every screen stays mounted (keeping its state) with the
 * top one over the rest. A push slides in from the right, a pop slides out,
 * and a swipe from the left edge drags the top screen back.
 */
export function StackView() {
  const { screens, pop } = useStack()
  const [motion, setMotion] = useState<Motion>({
    screens,
    entering: null,
    leaving: null
  })
  if (motion.screens !== screens) {
    setMotion(nextMotion(motion.screens, screens))
  }

  const topRef = useRef<HTMLDivElement>(null)
  const swipe = useEdgeSwipe(
    () => {
      // Let the slide out run from where the finger let go.
      topRef.current!.style.transition = ''
      pop()
    },
    {
      onDrag(dx) {
        const el = topRef.current!
        el.style.transition = 'none'
        el.style.transform = `translate3d(${dx}px, 0, 0)`
      },
      onCancel() {
        const el = topRef.current!
        el.style.transition = ''
        el.style.transform = ''
      }
    }
  )

  const leaving = motion.leaving
  const clearLeaving = useCallback(() => {
    setMotion(m => (m.leaving ? { ...m, leaving: null } : m))
  }, [])
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(clearLeaving, LEAVE_FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [leaving, clearLeaving])

  const onLeaveEnd = (e: TransitionEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) clearLeaving()
  }

  const layers = leaving ? [...screens, leaving] : screens
  const topIndex = screens.length - 1
  return (
    <div className="stack-view">
      {layers.map((entry, i) => {
        const isTop = i === topIndex
        const isLeaving = i > topIndex
        const className = [
          'stack-layer',
          entry.key === motion.entering && 'stack-enter',
          isLeaving && 'stack-leave'
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <div
            key={entry.key}
            ref={isTop ? topRef : undefined}
            data-stack-key={entry.key}
            className={className}
            // Deeper screens paint above shallower ones (a leaving screen is
            // the deepest until it has slid out).
            style={{ zIndex: i + 1 }}
            inert={!isTop}
            aria-hidden={isTop ? undefined : true}
            onTransitionEnd={isLeaving ? onLeaveEnd : undefined}
            {...(isTop && topIndex > 0 ? swipe : undefined)}
          >
            <ScreenActiveContext.Provider value={isTop}>
              <ScreenContent entry={entry} />
            </ScreenActiveContext.Provider>
          </div>
        )
      })}
    </div>
  )
}
