// The search mode and sources controls, shared by the composer's options
// sheet and Settings: both change the same search settings.

import { useId } from 'react'

import { haptic } from '@/core/haptics'
import type { SearchSettings } from '@/features/thread/chat-body'
import type { SearchMode, SourceMode } from '@/lib/types/search'

/** The search modes, in the order the controls list them. */
export const SEARCH_MODE_LABELS: Record<SearchMode, string> = {
  speed: 'Speed',
  balanced: 'Balanced',
  quality: 'Quality'
}

export const SEARCH_MODES: { value: SearchMode; label: string }[] = (
  ['speed', 'balanced', 'quality'] as const
).map(value => ({ value, label: SEARCH_MODE_LABELS[value] }))

const SOURCES: { value: SourceMode; label: string }[] = [
  { value: 'web', label: 'Web' },
  { value: 'academic', label: 'Academic' },
  { value: 'social', label: 'Social' }
]

const SECTION_TITLE =
  'px-4 pb-2 text-xs font-medium uppercase tracking-wide text-foreground/50'
const GROUP = 'rounded-2xl bg-foreground/5'

export type SearchOptionFieldProps = {
  settings: SearchSettings
  onSettings: (settings: SearchSettings) => void
}

/** The search mode as a segmented control. */
export function SearchModeField({
  settings,
  onSettings
}: SearchOptionFieldProps) {
  const modeLabel = useId()
  const setMode = (searchMode: SearchMode) => {
    if (searchMode === settings.searchMode) return
    haptic('selection')
    onSettings({ ...settings, searchMode })
  }

  return (
    <section>
      <h3 id={modeLabel} className={SECTION_TITLE}>
        Search mode
      </h3>
      <div
        role="radiogroup"
        aria-labelledby={modeLabel}
        className={`${GROUP} flex gap-1 p-1`}
      >
        {SEARCH_MODES.map(mode => {
          const checked = mode.value === settings.searchMode
          return (
            <button
              key={mode.value}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => setMode(mode.value)}
              className={`min-h-11 flex-1 touch-manipulation rounded-xl text-sm font-medium ${
                checked
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-foreground/60 active:opacity-50'
              }`}
            >
              {mode.label}
            </button>
          )
        })}
      </div>
    </section>
  )
}

/** The sources as toggles; the last one on cannot be turned off. */
export function SourcesField({ settings, onSettings }: SearchOptionFieldProps) {
  const toggleSource = (source: SourceMode) => {
    const on = settings.sources.includes(source)
    // At least one source always stays on.
    if (on && settings.sources.length === 1) return
    haptic('selection')
    const sources = SOURCES.map(s => s.value).filter(s =>
      s === source ? !on : settings.sources.includes(s)
    )
    onSettings({ ...settings, sources })
  }

  return (
    <section>
      <h3 className={SECTION_TITLE}>Sources</h3>
      <div className="flex gap-2">
        {SOURCES.map(source => {
          const on = settings.sources.includes(source.value)
          const locked = on && settings.sources.length === 1
          return (
            <button
              key={source.value}
              type="button"
              aria-pressed={on}
              aria-disabled={locked || undefined}
              onClick={() => toggleSource(source.value)}
              className={`min-h-11 flex-1 touch-manipulation rounded-xl text-sm font-medium ${
                on
                  ? 'bg-foreground text-background'
                  : 'bg-foreground/5 text-foreground/60'
              } ${locked ? '' : 'active:opacity-50'}`}
            >
              {source.label}
            </button>
          )
        })}
      </div>
    </section>
  )
}
