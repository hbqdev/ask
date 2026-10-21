// The app's light/dark theme. The user picks System, Light or Dark; System
// follows the device setting. The native container (MainViewController)
// watches <html>'s class and style and the device setting, and matches its
// own colour and the status bar to the page, so the page is all we set.

export type ThemePref = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

/** The Preferences key that holds the user's choice. */
export const THEME_STORAGE_KEY = 'theme'

/** The media query for the device's dark setting. */
export const DARK_QUERY = '(prefers-color-scheme: dark)'

export function resolveTheme(
  pref: ThemePref,
  systemDark: boolean
): ResolvedTheme {
  if (pref === 'system') return systemDark ? 'dark' : 'light'
  return pref
}

/** A stored value as a preference; anything missing or unknown is System. */
export function parseThemePref(value: string | null): ThemePref {
  return value === 'light' || value === 'dark' ? value : 'system'
}

/**
 * Puts the theme on the page: exactly one of the `dark` and `light` classes
 * (styles.css keys the palette off them), and a matching `color-scheme` so
 * form controls and scrollbars agree.
 */
export function applyTheme(
  theme: ResolvedTheme,
  root: HTMLElement = document.documentElement
): void {
  root.classList.toggle('dark', theme === 'dark')
  root.classList.toggle('light', theme === 'light')
  root.style.colorScheme = theme
}
