import {
  createContext,
  memo,
  useCallback,
  useContext,
  useId,
  useState,
  type ReactNode
} from 'react'

export type TabId = 'ask' | 'library' | 'settings'

export type TabSpec = {
  id: TabId
  label: string
  icon: ReactNode
  render(): ReactNode
}

export type TabsProps = { tabs: TabSpec[]; initial?: TabId }

const SelectTabContext = createContext<((id: TabId) => void) | undefined>(
  undefined
)

/** Switches the tab shell to a tab; undefined outside the shell. */
export function useSelectTab(): ((id: TabId) => void) | undefined {
  return useContext(SelectTabContext)
}

// Switching tabs re-renders Tabs only; a kept tab's content does not re-render.
const TabContent = memo(function TabContent({ tab }: { tab: TabSpec }) {
  return tab.render()
})

/**
 * The app's tab shell: a bottom tab bar over one panel per tab. A tab mounts
 * the first time it is opened and then stays mounted (hidden when inactive),
 * so its state and scroll position survive switching away and back.
 */
export function Tabs({ tabs, initial }: TabsProps) {
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

  return (
    <SelectTabContext.Provider value={select}>
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
                className="absolute inset-0 flex flex-col"
                // visibility, not display: the panel keeps its layout and scroll
                // position while hidden.
                style={isActive ? undefined : { visibility: 'hidden' }}
                inert={!isActive}
              >
                <TabContent tab={tab} />
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
                onClick={() => select(tab.id)}
                className={`flex min-h-11 flex-1 touch-manipulation flex-col items-center justify-center gap-0.5 text-[11px] font-medium active:opacity-50 ${
                  isActive ? 'text-mark-blue' : 'text-foreground/55'
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
