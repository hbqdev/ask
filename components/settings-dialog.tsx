'use client'

import { useEffect, useState } from 'react'

import {
  IconAdjustments,
  IconBrain,
  IconChevronLeft,
  IconNotes,
  IconPalette
} from '@tabler/icons-react'

import { cn } from '@/lib/utils'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

import { MemoryTab } from '@/components/settings/memory-tab'
import { useTheme } from '@/components/theme-provider'

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------
function lsGet(key: string): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(key)
}
function lsSet(key: string, value: string) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(key, value)
  window.dispatchEvent(
    new CustomEvent('client-config-changed', { detail: key })
  )
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------
const TABS = [
  {
    key: 'preferences',
    label: 'Preferences',
    description: 'Customize your application preferences.',
    icon: IconAdjustments
  },
  {
    key: 'personalization',
    label: 'Personalization',
    description: 'Customize the behavior and tone of the model.',
    icon: IconPalette
  },
  {
    key: 'models',
    label: 'Models',
    description: 'View model and server configuration.',
    icon: IconBrain
  },
  {
    key: 'memory',
    label: 'Memory',
    description: 'Manage what Ask remembers about you.',
    icon: IconNotes
  }
] as const
type TabKey = (typeof TABS)[number]['key']

// ---------------------------------------------------------------------------
// Vane-style card — matches `rounded-xl border border-light-200 bg-light-primary/80 p-4 lg:p-6`
// ---------------------------------------------------------------------------
export function SettingRow({
  title,
  description,
  children,
  inline = false
}: {
  title: string
  description: string
  children: React.ReactNode
  inline?: boolean
}) {
  return (
    <section
      className={cn(
        'rounded-xl border border-border bg-background/80 p-4 lg:p-6 transition-colors flex',
        inline
          ? 'flex-row items-center justify-between gap-5'
          : 'flex-col gap-0'
      )}
    >
      <div className={cn('flex flex-col', !inline && 'mb-3 lg:mb-5')}>
        <h4 className="text-sm text-foreground">{title}</h4>
        <p className="text-[11px] lg:text-xs text-foreground/50">
          {description}
        </p>
      </div>
      <div className={cn(inline ? 'shrink-0' : 'w-full')}>{children}</div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Vane-style select — matches `bg-light-secondary dark:bg-dark-secondary border-light-200`
// ---------------------------------------------------------------------------
function SettingSelect({
  value,
  onChange,
  options
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="relative inline-flex w-full items-center">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="bg-muted px-3 py-2 flex items-center overflow-hidden border border-border text-foreground rounded-lg appearance-none w-full pr-10 text-xs lg:text-sm focus:outline-none"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-3 flex h-4 w-4 items-center justify-center text-foreground/50">
        <svg
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          className="h-4 w-4"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Vane-style switch — `h-6 w-12 bg-muted data-checked:bg-sky-500`
// ---------------------------------------------------------------------------
export function SettingSwitch({
  checked,
  onChange
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'group relative flex h-6 w-12 shrink-0 cursor-pointer rounded-full p-1 duration-200 ease-in-out focus:outline-none transition-colors',
        checked ? 'bg-sky-500' : 'bg-muted'
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block size-4 rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out',
          checked ? 'translate-x-6' : 'translate-x-0'
        )}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Preferences tab
// ---------------------------------------------------------------------------
function PreferencesTab() {
  const { theme, setTheme } = useTheme()
  const [measureUnit, setMeasureUnit] = useState('metric')
  const [showWeather, setShowWeather] = useState(true)
  const [showNews, setShowNews] = useState(true)

  useEffect(() => {
    // Reads localStorage after mount (client-only) — intentional, so the
    // initial render matches SSR and hydrates without a mismatch. The
    // set-state-in-effect rule is a false positive for this pattern.
    /* eslint-disable react-hooks/set-state-in-effect */
    setMeasureUnit(lsGet('measureUnit') ?? 'metric')
    setShowWeather(lsGet('showWeatherWidget') !== 'false')
    setShowNews(lsGet('showNewsWidget') !== 'false')
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [])

  return (
    <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
      <SettingRow
        title="Theme"
        description="Choose between light and dark layouts for the app."
      >
        <SettingSelect
          value={theme ?? 'system'}
          onChange={v => setTheme(v)}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' }
          ]}
        />
      </SettingRow>

      <SettingRow
        title="Measurement Unit"
        description="Choose between Metric and Imperial measurement unit."
      >
        <SettingSelect
          value={measureUnit}
          onChange={v => {
            setMeasureUnit(v)
            lsSet('measureUnit', v)
          }}
          options={[
            { value: 'metric', label: 'Metric' },
            { value: 'imperial', label: 'Imperial' }
          ]}
        />
      </SettingRow>

      <SettingRow
        title="Show weather widget"
        description="Display the weather card on the home screen."
        inline
      >
        <SettingSwitch
          checked={showWeather}
          onChange={v => {
            setShowWeather(v)
            lsSet('showWeatherWidget', String(v))
          }}
        />
      </SettingRow>

      <SettingRow
        title="Show news widget"
        description="Display the recent news card on the home screen."
        inline
      >
        <SettingSwitch
          checked={showNews}
          onChange={v => {
            setShowNews(v)
            lsSet('showNewsWidget', String(v))
          }}
        />
      </SettingRow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Personalization tab
// ---------------------------------------------------------------------------
function PersonalizationTab() {
  const [instructions, setInstructions] = useState('')

  useEffect(() => {
    // Reads localStorage after mount (client-only) — intentional, so the
    // initial render matches SSR and hydrates without a mismatch. The
    // set-state-in-effect rule is a false positive for this pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInstructions(lsGet('systemInstructions') ?? '')
  }, [])

  return (
    <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
      <SettingRow
        title="System Instructions"
        description='Add custom behavior or tone for the model. e.g. "Respond in a friendly and concise tone" or "Use British English."'
      >
        <textarea
          value={instructions}
          onChange={e => setInstructions(e.target.value)}
          onBlur={() => lsSet('systemInstructions', instructions)}
          placeholder='e.g., "Respond in a friendly and concise tone"'
          rows={4}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 lg:px-4 lg:py-3 text-xs lg:text-[13px] text-foreground/80 placeholder:text-foreground/40 focus-visible:outline-none transition-colors resize-none"
        />
      </SettingRow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Models tab
// ---------------------------------------------------------------------------
function ModelsTab() {
  const ollamaBase =
    process.env.NEXT_PUBLIC_OLLAMA_BASE_URL ?? 'http://192.168.50.231:11434'

  return (
    <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
      <SettingRow
        title="Chat Model"
        description="Use the model selector in the search bar to choose your active model. Models are served via Ollama."
      >
        <p className="text-xs text-foreground/50">
          Configured via{' '}
          <code className="bg-muted px-1 rounded">OLLAMA_BASE_URL</code> in{' '}
          <code className="bg-muted px-1 rounded">.env</code>
        </p>
      </SettingRow>

      <SettingRow
        title="Ollama Server"
        description="Native Ollama API — no API key required. Cloud models listed via OLLAMA_MODELS."
      >
        <code className="text-xs bg-muted px-3 py-2 rounded-lg border border-border block text-foreground/80">
          {ollamaBase}
        </code>
      </SettingRow>

      <SettingRow
        title="Embedding Model"
        description="Used for semantic search over uploaded files (RAG). Set OLLAMA_EMBED_MODEL in .env."
      >
        <div className="space-y-1.5">
          <p className="text-xs text-foreground/50">
            Recommended:{' '}
            <code className="bg-muted px-1 rounded">nomic-embed-text</code> (137
            MB) or{' '}
            <code className="bg-muted px-1 rounded">mxbai-embed-large</code>{' '}
            (670 MB)
          </p>
          <p className="text-xs text-foreground/50">
            Pull:{' '}
            <code className="bg-muted px-1 rounded">
              ollama pull nomic-embed-text
            </code>
          </p>
        </div>
      </SettingRow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------
interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('preferences')
  const activeSection = TABS.find(t => t.key === activeTab)!

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="
        max-w-none p-0 gap-0 overflow-hidden rounded-xl border border-border
        w-[calc(100vw-2%)] h-[calc(100vh-2%)]
        md:w-[calc(100vw-7%)] md:h-[calc(100vh-7%)]
        lg:w-[calc(100vw-30%)] lg:h-[calc(100vh-20%)]
      "
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="flex h-full overflow-hidden">
          {/* Sidebar — matches Vane: w-[240px] px-3 pt-3 */}
          <div className="hidden lg:flex flex-col justify-between w-[240px] shrink-0 border-r border-border h-full px-3 pt-3 overflow-y-auto">
            <div className="flex flex-col">
              {/* Back button — matches Vane: p-2 rounded-lg hover:bg-muted text-[14px] */}
              <button
                onClick={() => onOpenChange(false)}
                className="group flex flex-row items-center hover:bg-muted p-2 rounded-lg"
              >
                <IconChevronLeft
                  size={18}
                  className="text-foreground/50 group-hover:text-foreground/70"
                />
                <p className="text-foreground/50 group-hover:text-foreground/70 text-[14px]">
                  Back
                </p>
              </button>

              {/* Nav items — matches Vane: space-y-1 mt-8, px-2 py-1.5 */}
              <div className="flex flex-col items-start space-y-1 mt-8">
                {TABS.map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => setActiveTab(key)}
                    className={cn(
                      'flex flex-row items-center space-x-2 px-2 py-1.5 rounded-lg w-full text-sm hover:bg-muted transition duration-200 active:scale-95',
                      activeTab === key
                        ? 'bg-muted text-foreground/90'
                        : 'text-foreground/70'
                    )}
                  >
                    <Icon size={17} />
                    <p>{label}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Footer — matches Vane: py-[18px] px-2 */}
            <div className="flex flex-col space-y-1 py-[18px] px-2">
              <p className="text-xs text-foreground/70">Ask — self-hosted</p>
            </div>
          </div>

          {/* Content */}
          <div className="w-full flex flex-col overflow-hidden">
            {/* Mobile/tablet tab bar. The sidebar above is `hidden lg:flex`, so
                below the lg breakpoint it is gone entirely — without this row
                there is NO way to reach any tab but the default (Memory,
                Personalization and Models become unreachable on any window
                narrower than 1024px). Shown only below lg, so it and the
                sidebar are mutually exclusive and cover every width. */}
            <div className="lg:hidden flex flex-row gap-1 overflow-x-auto border-b border-border/60 pl-3 pr-12 py-2 flex-shrink-0">
              {TABS.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={cn(
                    'flex flex-row items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm whitespace-nowrap shrink-0 transition-colors active:scale-95',
                    activeTab === key
                      ? 'bg-muted text-foreground/90'
                      : 'text-foreground/70 hover:bg-muted'
                  )}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                </button>
              ))}
            </div>

            {/* Section header — matches Vane: border-b px-6 pb-6 lg:pt-6 */}
            <div className="border-b border-border/60 px-6 pb-6 pt-6 flex-shrink-0">
              <div className="flex flex-col">
                <h4 className="font-medium text-foreground text-sm">
                  {activeSection.label}
                </h4>
                <p className="text-[11px] lg:text-xs text-foreground/50">
                  {activeSection.description}
                </p>
              </div>
            </div>

            {/* Scrollable section content */}
            <div className="flex-1 overflow-y-auto">
              {activeTab === 'preferences' && <PreferencesTab />}
              {activeTab === 'personalization' && <PersonalizationTab />}
              {activeTab === 'models' && <ModelsTab />}
              {activeTab === 'memory' && <MemoryTab />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
