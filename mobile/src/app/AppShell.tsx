import type { ReactNode } from 'react'

import { useHideSplash } from '@/app/splash'
import { Tabs, type TabSpec } from '@/app/Tabs'
import { useAuth } from '@/core/auth/AuthProvider'
import { StackProvider, StackView, type ScreenEntry } from '@/core/nav/stack'
import { useTheme } from '@/core/ThemeProvider'
import { OrbitMark } from '@/core/ui/OrbitMark'
import { SignInScreen } from '@/features/auth/SignInScreen'
import { SettingsScreen } from '@/features/settings/SettingsScreen'

// --- Tab icons (24px line icons in the tab's text colour) -------------------

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-6"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

const ASK_ICON = (
  <Icon>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
)

const LIBRARY_ICON = (
  <Icon>
    <path d="M4 6h16M4 12h16M4 18h10" />
  </Icon>
)

const SETTINGS_ICON = (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
  </Icon>
)

// --- Placeholder screens (later tasks replace these) ------------------------

function AskPlaceholder() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
      <OrbitMark className="size-14" />
      <h1 className="text-2xl font-semibold tracking-tight">Ask anything</h1>
    </main>
  )
}

function LibraryPlaceholder() {
  return (
    <main className="flex flex-1 flex-col px-4 pt-6">
      <h1 className="px-2 text-3xl font-bold tracking-tight">Library</h1>
      <p className="flex flex-1 items-center justify-center text-foreground/55">
        Your chats will appear here
      </p>
    </main>
  )
}

// Module constants: Tabs memoizes each tab's content on its spec, and the
// stack keeps its root entry, so these must not change between renders.
const TABS: TabSpec[] = [
  { id: 'ask', label: 'Ask', icon: ASK_ICON, render: () => <AskPlaceholder /> },
  {
    id: 'library',
    label: 'Library',
    icon: LIBRARY_ICON,
    render: () => <LibraryPlaceholder />
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: SETTINGS_ICON,
    render: () => <SettingsScreen />
  }
]

const TABS_SCREEN: ScreenEntry = {
  key: 'tabs',
  render: () => <Tabs tabs={TABS} />
}

/** What launch shows until the session is known: the native splash's look. */
function LaunchView() {
  return (
    <div
      data-testid="app-splash"
      className="flex flex-1 items-center justify-center bg-splash"
    >
      <OrbitMark className="size-24" />
    </div>
  )
}

/**
 * The app's top level: the launch view while the stored session is read,
 * sign-in when signed out, and the tab shell (inside a navigation stack)
 * when signed in. The native splash stays up until the theme and the
 * session are both known.
 */
export function AppShell({ apiBaseUrl }: { apiBaseUrl: string }) {
  const { status } = useAuth()
  const { loaded } = useTheme()
  useHideSplash(loaded && status !== 'loading')

  if (status === 'loading') return <LaunchView />
  if (status === 'signedOut') return <SignInScreen apiBaseUrl={apiBaseUrl} />
  return (
    <StackProvider root={TABS_SCREEN}>
      <StackView />
    </StackProvider>
  )
}
