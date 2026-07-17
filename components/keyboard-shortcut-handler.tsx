'use client'

import { toast } from 'sonner'

import { SHORTCUT_EVENTS, SHORTCUTS } from '@/lib/keyboard-shortcuts'
import { SearchMode, SearchSources } from '@/lib/types/search'
import { getCookie, setCookie } from '@/lib/utils/cookies'

import { useKeyboardShortcut } from '@/hooks/use-keyboard-shortcut'

import { useSidebar } from './ui/sidebar'
import { KeyboardShortcutDialog } from './keyboard-shortcut-dialog'
import { useTheme } from './theme-provider'

const THEME_CYCLE: Record<string, string> = {
  dark: 'light',
  light: 'system',
  system: 'dark'
}

const SEARCH_MODE_LABELS: Record<SearchMode, string> = {
  speed: 'Speed',
  balanced: 'Balanced',
  quality: 'Quality'
}

const SEARCH_MODE_CYCLE: Record<string, SearchMode> = {
  speed: 'balanced',
  balanced: 'quality',
  quality: 'speed'
}

// Cycle: web only → academic only → social only → web only
const SOURCES_CYCLE: SearchSources[] = [['web'], ['academic'], ['social']]
const SOURCES_LABELS: Record<string, string> = {
  '["web"]': 'Web',
  '["academic"]': 'Academic',
  '["social"]': 'Social'
}

export function KeyboardShortcutHandler() {
  const { theme, setTheme } = useTheme()
  const { toggleSidebar } = useSidebar()

  useKeyboardShortcut(SHORTCUTS.toggleSidebar, toggleSidebar)

  useKeyboardShortcut(SHORTCUTS.newChat, () => {
    window.dispatchEvent(
      new CustomEvent(SHORTCUT_EVENTS.newChat, { cancelable: true })
    )
  })

  useKeyboardShortcut(SHORTCUTS.toggleTheme, () => {
    setTheme(THEME_CYCLE[theme ?? 'system'] ?? 'dark')
  })

  useKeyboardShortcut(SHORTCUTS.copyMessage, () => {
    window.dispatchEvent(
      new CustomEvent(SHORTCUT_EVENTS.copyMessage, { cancelable: true })
    )
  })

  useKeyboardShortcut(SHORTCUTS.toggleSearchMode, () => {
    const raw = getCookie('searchMode') || 'balanced'
    // Backward compat: map old values
    const current =
      raw === 'quick' ? 'speed' : raw === 'adaptive' ? 'balanced' : raw
    const next: SearchMode = SEARCH_MODE_CYCLE[current] ?? 'balanced'
    setCookie('searchMode', next)
    toast.info(`Search mode: ${SEARCH_MODE_LABELS[next]}`)
  })

  useKeyboardShortcut(SHORTCUTS.toggleSources, () => {
    const raw = getCookie('sources')
    let current: SearchSources = ['web']
    try {
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length > 0) current = parsed
      }
    } catch {
      // ignore
    }
    const currentKey = JSON.stringify(current)
    const currentIdx = SOURCES_CYCLE.findIndex(
      s => JSON.stringify(s) === currentKey
    )
    const next = SOURCES_CYCLE[(currentIdx + 1) % SOURCES_CYCLE.length]
    setCookie('sources', JSON.stringify(next))
    toast.info(
      `Sources: ${SOURCES_LABELS[JSON.stringify(next)] ?? JSON.stringify(next)}`
    )
  })

  useKeyboardShortcut(SHORTCUTS.showShortcuts, () => {
    window.dispatchEvent(new CustomEvent(SHORTCUT_EVENTS.showShortcuts))
  })

  return <KeyboardShortcutDialog />
}
