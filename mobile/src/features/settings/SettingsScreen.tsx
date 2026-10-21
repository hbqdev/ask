import { useId } from 'react'

import { useAuth } from '@/core/auth/AuthProvider'
import type { ThemePref } from '@/core/theme'
import { useTheme } from '@/core/ThemeProvider'

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

const SECTION_TITLE =
  'px-4 pb-2 text-xs font-medium uppercase tracking-wide text-foreground/50'
const GROUP = 'rounded-2xl bg-foreground/5'

/** The account, the theme, and signing out. */
export function SettingsScreen() {
  const { session, signOut } = useAuth()
  const { pref, setPref } = useTheme()
  const email = session?.user.email
  const themeLabel = useId()

  return (
    <main className="flex flex-1 flex-col gap-8 overflow-y-auto px-4 pt-6 pb-8">
      <h1 className="px-2 text-3xl font-bold tracking-tight">Settings</h1>

      {email && (
        <section>
          <h2 className={SECTION_TITLE}>Account</h2>
          <div className={`${GROUP} px-4 py-3`}>
            <p className="text-sm text-foreground/60">Signed in as</p>
            <p className="truncate text-base">{email}</p>
          </div>
        </section>
      )}

      <section>
        <h2 id={themeLabel} className={SECTION_TITLE}>
          Appearance
        </h2>
        <div
          role="radiogroup"
          aria-labelledby={themeLabel}
          className={`${GROUP} flex gap-1 p-1`}
        >
          {THEME_OPTIONS.map(option => {
            const checked = option.value === pref
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => setPref(option.value)}
                className={`min-h-11 flex-1 touch-manipulation rounded-xl text-sm font-medium ${
                  checked
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-foreground/60 active:opacity-50'
                }`}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </section>

      <section>
        <button
          type="button"
          onClick={() => void signOut()}
          className={`${GROUP} min-h-12 w-full touch-manipulation px-4 text-base font-medium text-red-500 active:opacity-60`}
        >
          Sign out
        </button>
      </section>
    </main>
  )
}
