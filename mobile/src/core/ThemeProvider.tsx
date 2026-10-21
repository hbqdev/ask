import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

import {
  preferencesStorage,
  type AuthStorage
} from '@/core/auth/preferences-storage'
import {
  applyTheme,
  DARK_QUERY,
  parseThemePref,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePref
} from '@/core/theme'

export type Theme = {
  /** What the user chose. */
  pref: ThemePref
  /** What is on screen: the choice, with System resolved. */
  resolved: ResolvedTheme
  /** Whether the stored choice has been read (or failed to read). */
  loaded: boolean
  setPref(pref: ThemePref): void
}

const ThemeContext = createContext<Theme | null>(null)

const systemIsDark = () => window.matchMedia(DARK_QUERY).matches

/**
 * Owns the theme. Preferences cannot be read before the first paint, so the
 * app starts on System (the device setting, applied before paint) and moves
 * to the stored choice once it loads.
 */
export function ThemeProvider({
  storage = preferencesStorage,
  children
}: {
  storage?: AuthStorage
  children: ReactNode
}) {
  const [pref, setPrefState] = useState<ThemePref>('system')
  const [loaded, setLoaded] = useState(false)
  const [systemDark, setSystemDark] = useState(systemIsDark)
  // Set once the user picks a theme, so a slow load cannot undo their pick.
  const chosen = useRef(false)

  useEffect(() => {
    storage
      .getItem(THEME_STORAGE_KEY)
      .then(value => {
        if (!chosen.current) setPrefState(parseThemePref(value))
      })
      // Unreadable storage leaves the app on System.
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [storage])

  // Only System listens to the device; an explicit choice ignores it.
  useEffect(() => {
    if (pref !== 'system') return
    const query = window.matchMedia(DARK_QUERY)
    const onChange = (event: MediaQueryListEvent) =>
      setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [pref])

  const resolved = resolveTheme(pref, systemDark)

  // Before paint, so a change never shows a frame in the old theme.
  useLayoutEffect(() => {
    applyTheme(resolved)
  }, [resolved])

  const setPref = useCallback(
    (next: ThemePref) => {
      chosen.current = true
      // The device may have changed while an explicit theme was chosen.
      if (next === 'system') setSystemDark(systemIsDark())
      setPrefState(next)
      // A failed save only costs the choice at the next launch.
      storage.setItem(THEME_STORAGE_KEY, next).catch(() => {})
    },
    [storage]
  )

  const theme = useMemo(
    () => ({ pref, resolved, loaded, setPref }),
    [pref, resolved, loaded, setPref]
  )

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext)
  if (!theme) throw new Error('useTheme must be used inside ThemeProvider')
  return theme
}
