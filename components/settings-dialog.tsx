'use client'

import { useEffect, useState } from 'react'

import {
  IconAdjustments,
  IconBrain,
  IconChevronLeft,
  IconPalette,
  IconSearch
} from '@tabler/icons-react'
import { useTheme } from '@/components/theme-provider'

import { cn } from '@/lib/utils'

import {
  Dialog,
  DialogContent,
  DialogTitle
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

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
  window.dispatchEvent(new CustomEvent('client-config-changed', { detail: key }))
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------
const TABS = [
  { key: 'preferences', label: 'Preferences', description: 'Customize your application preferences.', icon: IconAdjustments },
  { key: 'personalization', label: 'Personalization', description: 'Customize the behavior and tone of the model.', icon: IconPalette },
  { key: 'models', label: 'Models', description: 'View model and server configuration.', icon: IconBrain },
  { key: 'search', label: 'Search', description: 'Manage search settings.', icon: IconSearch },
] as const
type TabKey = (typeof TABS)[number]['key']

// ---------------------------------------------------------------------------
// Shared SettingRow — Vane-style card
// ---------------------------------------------------------------------------
function SettingRow({
  title,
  description,
  children,
  inline = false,
}: {
  title: string
  description: string
  children: React.ReactNode
  inline?: boolean
}) {
  return (
    <section className={cn(
      'rounded-xl border border-border/60 bg-card/80 p-4 sm:p-6 flex gap-4 transition-colors',
      inline ? 'items-center justify-between' : 'flex-col'
    )}>
      <div className="flex flex-col gap-0.5 min-w-0">
        <h4 className="text-sm font-medium leading-none text-foreground">{title}</h4>
        <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
      </div>
      <div className={cn('shrink-0', !inline && 'w-full')}>{children}</div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Vane-style full-width select
// ---------------------------------------------------------------------------
function SettingSelect({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full appearance-none rounded-lg border border-border bg-background px-3 py-2.5 pr-8 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 cursor-pointer"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Vane-style switch (sky-500 when on)
// ---------------------------------------------------------------------------
function SettingSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none',
        checked ? 'bg-sky-500' : 'bg-muted'
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out',
          checked ? 'translate-x-5' : 'translate-x-0'
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
  const [autoMedia, setAutoMedia] = useState(true)
  const [showWeather, setShowWeather] = useState(true)
  const [showNews, setShowNews] = useState(true)

  useEffect(() => {
    setMeasureUnit(lsGet('measureUnit') ?? 'metric')
    setAutoMedia(lsGet('autoMediaSearch') !== 'false')
    setShowWeather(lsGet('showWeatherWidget') !== 'false')
    setShowNews(lsGet('showNewsWidget') !== 'false')
  }, [])

  return (
    <div className="space-y-4">
      <SettingRow title="Theme" description="Choose between light and dark layouts for the app.">
        <SettingSelect
          value={theme ?? 'system'}
          onChange={v => setTheme(v)}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </SettingRow>

      <SettingRow title="Measurement Unit" description="Choose between Metric and Imperial measurement unit.">
        <SettingSelect
          value={measureUnit}
          onChange={v => { setMeasureUnit(v); lsSet('measureUnit', v) }}
          options={[
            { value: 'metric', label: 'Metric' },
            { value: 'imperial', label: 'Imperial' },
          ]}
        />
      </SettingRow>

      <SettingRow title="Auto video & image search" description="Automatically search for relevant images and videos." inline>
        <SettingSwitch
          checked={autoMedia}
          onChange={v => { setAutoMedia(v); lsSet('autoMediaSearch', String(v)) }}
        />
      </SettingRow>

      <SettingRow title="Show weather widget" description="Display the weather card on the home screen." inline>
        <SettingSwitch
          checked={showWeather}
          onChange={v => { setShowWeather(v); lsSet('showWeatherWidget', String(v)) }}
        />
      </SettingRow>

      <SettingRow title="Show news widget" description="Display the recent news card on the home screen." inline>
        <SettingSwitch
          checked={showNews}
          onChange={v => { setShowNews(v); lsSet('showNewsWidget', String(v)) }}
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
    setInstructions(lsGet('systemInstructions') ?? '')
  }, [])

  return (
    <div className="space-y-4">
      <SettingRow
        title="System Instructions"
        description='Add custom behavior or tone for the model. e.g. "Respond in a friendly and concise tone" or "Use British English."'
      >
        <Textarea
          value={instructions}
          onChange={e => setInstructions(e.target.value)}
          onBlur={() => lsSet('systemInstructions', instructions)}
          placeholder='e.g., "Respond in a friendly and concise tone"'
          className="min-h-[120px] resize-y text-sm"
        />
      </SettingRow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Models tab
// ---------------------------------------------------------------------------
function ModelsTab() {
  const ollamaBase = process.env.NEXT_PUBLIC_OLLAMA_BASE_URL ?? 'http://192.168.50.231:11434'

  return (
    <div className="space-y-4">
      <SettingRow
        title="Chat Model"
        description="Use the model selector in the search bar to choose your active model. Models are served via Ollama."
      >
        <p className="text-xs text-muted-foreground">
          Configured via <code className="bg-muted px-1 rounded">OLLAMA_BASE_URL</code> in <code className="bg-muted px-1 rounded">.env</code>
        </p>
      </SettingRow>

      <SettingRow
        title="Ollama Server"
        description="Native Ollama API — no API key required. Cloud models listed via OLLAMA_MODELS."
      >
        <code className="text-xs bg-muted px-3 py-2 rounded-lg border border-border block">
          {ollamaBase}
        </code>
      </SettingRow>

      <SettingRow
        title="Embedding Model"
        description="Used for semantic search over uploaded files (RAG). Set OLLAMA_EMBED_MODEL in .env."
      >
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            Recommended: <code className="bg-muted px-1 rounded">nomic-embed-text</code> (137 MB) or <code className="bg-muted px-1 rounded">mxbai-embed-large</code> (670 MB)
          </p>
          <p className="text-xs text-muted-foreground">
            Pull: <code className="bg-muted px-1 rounded">ollama pull nomic-embed-text</code>
          </p>
        </div>
      </SettingRow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Search tab
// ---------------------------------------------------------------------------
function SearchTab() {
  const searxngUrl = process.env.NEXT_PUBLIC_SEARXNG_URL ?? 'https://search.hbqnexus.win'

  return (
    <div className="space-y-4">
      <SettingRow
        title="SearXNG URL"
        description="The URL of your SearXNG instance used for web search."
      >
        <code className="text-xs bg-muted px-3 py-2 rounded-lg border border-border block">
          {searxngUrl}
        </code>
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
      <DialogContent className="max-w-3xl p-0 gap-0 overflow-hidden">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="flex h-[600px]">

          {/* Sidebar */}
          <div className="w-56 shrink-0 border-r border-border/60 flex flex-col bg-card/40 overflow-y-auto">
            {/* Back button */}
            <button
              onClick={() => onOpenChange(false)}
              className="group flex items-center gap-1.5 px-3 py-3 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <IconChevronLeft className="size-4 group-hover:-translate-x-0.5 transition-transform duration-150" />
              Back
            </button>

            {/* Nav items */}
            <div className="flex flex-col gap-0.5 px-2 mt-4">
              {TABS.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left w-full',
                    activeTab === key
                      ? 'bg-muted text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  {label}
                </button>
              ))}
            </div>

            {/* Version at bottom */}
            <div className="mt-auto px-5 py-4">
              <p className="text-xs text-muted-foreground/60">Ask — self-hosted</p>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Section header */}
            <div className="border-b border-border/60 px-6 py-5 shrink-0">
              <h4 className="text-sm font-medium text-foreground">{activeSection.label}</h4>
              <p className="text-xs text-muted-foreground">{activeSection.description}</p>
            </div>

            {/* Scrollable settings */}
            <div className="flex-1 overflow-y-auto px-6 py-6">
              {activeTab === 'preferences' && <PreferencesTab />}
              {activeTab === 'personalization' && <PersonalizationTab />}
              {activeTab === 'models' && <ModelsTab />}
              {activeTab === 'search' && <SearchTab />}
            </div>
          </div>

        </div>
      </DialogContent>
    </Dialog>
  )
}
