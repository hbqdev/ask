import { useEffect, useState } from 'react'

/**
 * Reads a boolean preference from localStorage (matching settings-dialog.tsx's
 * lsGet/lsSet convention: stored as the string "true"/"false", defaulting to
 * `true` unless explicitly set to "false"). Re-reads live when settings-dialog
 * dispatches `client-config-changed` after the user flips the toggle.
 */
export function useClientSettingEnabled(key: string): boolean {
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    const read = () => setEnabled(localStorage.getItem(key) !== 'false')
    read()

    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      if (detail === undefined || detail === key) read()
    }
    window.addEventListener('client-config-changed', onChange)
    return () => window.removeEventListener('client-config-changed', onChange)
  }, [key])

  return enabled
}
