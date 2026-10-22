import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode
} from 'react'

import { haptic } from '@/core/haptics'
import { scrollActiveToTop } from '@/core/nav/scroll-to-top'
import { focusHeading } from '@/core/ui/focus'

export type TabId = 'ask' | 'discover' | 'library' | 'settings'

export type TabSpec = {
  id: TabId
  label: string
  icon: ReactNode
  render(): ReactNode
}

export type TabsProps = {
  tabs: TabSpec[]
  initial?: TabId
  /** Non-visual helpers that switch tabs (they can use useSelectTab). */
  children?: ReactNode
}

const SelectTabContext = createContext<((id: TabId) => void) | undefined>(
  undefined
)

/** Switches the tab shell to a tab; undefined outside the shell. */
export function useSelectTab(): ((id: TabId) => void) | undefined {
  return useContext(SelectTabContext)
}

const TabActiveContext = createContext(true)

/**
 * Whether the tab holding this content is the one shown (true outside the
 * shell). Kept tabs stay mounted while hidden, so this is how their content
 * knows it was left or shown again.
 */
export function useTabActive(): boolean {
  return useContext(TabActiveContext)
}

/**
 * Narrows useTabActive for a part of a tab that hides itself while the tab
 * is shown (the Library's segments): inside, it is true only while both the
 * tab and this part are shown.
 */
export function ActiveWithin({
  shown,
  children
}: {
  shown: boolean
  children: ReactNode
}) {
  const tabShown = useTabActive()
  return (
    <TabActiveContext.Provider value={tabShown && shown}>
      {children}
    </TabActiveContext.Provider>
  )
}

// Switching tabs re-renders Tabs only; a kept tab's content does not re-render.
const TabContent = memo(function TabContent({ tab }: { tab: TabSpec }) {
  return tab.render()
})

/**
 * The app's tab shell: a bottom tab bar over one panel per tab. A tab mounts
 * the first time it is opened and then stays mounted (hidden when inactive),
 * so its state and scroll position survive switching away and back. A tap on
 * another tab moves focus to its title; a tap on the tab shown scrolls it to
 * the top.
 */
export function Tabs({ tabs, initial, children }: TabsProps) {
  const idPrefix = useId()
  const [active, setActive] = useState<TabId>(() => initial ?? tabs[0].id)
  const [opened, setOpened] = useState<ReadonlySet<TabId>>(
    () => new Set([active])
  )

  // Stable, so tab content reading it through context never re-renders.
  const select = useCallback((id: TabId) => {
    setActive(id)
    setOpened(prev => (prev.has(id) ? prev : new Set(prev).add(id)))
  }, [])

  const tabId = (id: TabId) => `${idPrefix}-tab-${id}`
  const panelId = (id: TabId) => `${idPrefix}-panel-${id}`

  // Set by a tap that switches tabs: once the tab is shown, its title takes
  // focus (VoiceOver reads the new tab from the top). A switch the app makes
  // leaves focus where it is.
  const tapped = useRef(false)
  useEffect(() => {
    if (!tapped.current) return
    tapped.current = false
    focusHeading(document.getElementById(panelId(active))!)
    // panelId only reads the stable idPrefix.
  }, [active])

  return (
    <SelectTabContext.Provider value={select}>
      {children}
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          {tabs.map(tab => {
            if (!opened.has(tab.id)) return null
            const isActive = tab.id === active
            return (
              <div
                key={tab.id}
                id={panelId(tab.id)}
                role="tabpanel"
                aria-labelledby={tabId(tab.id)}
                // isolate: the panel's sticky or fixed layers stay inside it.
                className="absolute inset-0 isolate flex flex-col"
                // visibility, not display: the panel keeps its layout and scroll
                // position while hidden.
                style={isActive ? undefined : { visibility: 'hidden' }}
                inert={!isActive}
              >
                <TabActiveContext.Provider value={isActive}>
                  <TabContent tab={tab} />
                </TabActiveContext.Provider>
              </div>
            )
          })}
        </div>
        <div
          role="tablist"
          aria-label="Sections"
          className="tab-bar flex border-t border-foreground/10 bg-background pt-1.5"
        >
          {tabs.map(tab => {
            const isActive = tab.id === active
            return (
              <button
                key={tab.id}
                id={tabId(tab.id)}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={opened.has(tab.id) ? panelId(tab.id) : undefined}
                onClick={() => {
                  // As in iOS: the tab shown goes back to its top.
                  if (isActive) {
                    scrollActiveToTop()
                    return
                  }
                  // A tap on the bar ticks; a switch the app makes does not.
                  haptic('selection')
                  tapped.current = true
                  select(tab.id)
                }}
                className={`flex min-h-11 flex-1 touch-manipulation flex-col items-center justify-center gap-0.5 text-[clamp(10px,0.6875rem,13px)] leading-none font-medium active:opacity-50 ${
                  isActive ? 'text-accent' : 'text-foreground/55'
                }`}
              >
                <span
                  aria-hidden="true"
                  className="flex size-6 items-center justify-center"
                >
                  {tab.icon}
                </span>
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>
    </SelectTabContext.Provider>
  )
}
