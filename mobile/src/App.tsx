import type { SupabaseClient } from '@supabase/supabase-js'

import { AppShell } from '@/app/AppShell'
import { ErrorBoundary } from '@/app/ErrorBoundary'
import { useHideSplash } from '@/app/splash'
import { AuthProvider } from '@/core/auth/AuthProvider'
import { createSupabase } from '@/core/auth/supabase'
import { getConfig, type AppConfig } from '@/core/config'
import { ThemeProvider, useTheme } from '@/core/ThemeProvider'

type Startup = { client: SupabaseClient; config: AppConfig } | { error: string }

// One Supabase client for the life of the app, made on first render (not at
// import, so importing App never throws). A build without Supabase values
// gets an error screen rather than a crash to a blank page.
let startup: Startup | undefined

function start(): Startup {
  try {
    const config = getConfig()
    return { client: createSupabase(config), config }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function ConfigError({ message }: { message: string }) {
  const { loaded } = useTheme()
  useHideSplash(loaded)
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <h1 className="text-xl font-semibold tracking-tight">
        Ask isn't configured
      </h1>
      <p className="text-sm text-foreground/60">{message}</p>
    </main>
  )
}

export default function App() {
  startup ??= start()
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <div
          data-testid="app-root"
          className="flex h-dvh flex-col bg-background text-foreground"
        >
          {'client' in startup ? (
            <AuthProvider client={startup.client}>
              <AppShell apiBaseUrl={startup.config.apiBaseUrl} />
            </AuthProvider>
          ) : (
            <ConfigError message={startup.error} />
          )}
        </div>
      </ThemeProvider>
    </ErrorBoundary>
  )
}
