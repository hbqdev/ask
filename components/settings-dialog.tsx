'use client'

import { useEffect, useRef, useState } from 'react'

import {
  IconAdjustments,
  IconBrain,
  IconPalette,
  IconSearch,
  IconSettings
} from '@tabler/icons-react'
import { useTheme } from '@/components/theme-provider'

import { cn } from '@/lib/utils'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

// ---------------------------------------------------------------------------
// localStorage helpers (Vane pattern — no cookies for UI prefs)
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
  { key: 'preferences', label: 'Preferences', icon: IconAdjustments },
  { key: 'personalization', label: 'Personalization', icon: IconPalette },
  { key: 'models', label: 'Models', icon: IconBrain },
  { key: 'search', label: 'Search', icon: IconSearch },
] as const
type TabKey = (typeof TABS)[number]['key']

// ---------------------------------------------------------------------------
// Preferences tab
// ---------------------------------------------------------------------------
function PreferencesTab() {
  const { theme, setTheme } = useTheme()
  const [measureUnit, setMeasureUnit] = useState<string>('metric')
  const [autoMedia, setAutoMedia] = useState(true)
  const [showWeather, setShowWeather] = useState(true)
  const [showNews, setShowNews] = useState(true)

  useEffect(() => {
    setMeasureUnit(lsGet('measureUnit') ?? 'metric')
    setAutoMedia(lsGet('autoMediaSearch') !== 'false')
    setShowWeather(lsGet('showWeatherWidget') !== 'false')
    setShowNews(lsGet('showNewsWidget') !== 'false')
  }, [])

  const toggle = (key: string, value: boolean, setter: (v: boolean) => void) => {
    setter(value)
    lsSet(key, String(value))
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Theme */}
      <SettingRow
        title="Theme"
        description="Choose between light and dark layouts for the app."
      >
        <select
          value={theme ?? 'system'}
          onChange={e => setTheme(e.target.value)}
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </SettingRow>

      {/* Measurement unit */}
      <SettingRow
        title="Measurement Unit"
        description="Choose between Metric and Imperial measurement unit."
      >
        <select
          value={measureUnit}
          onChange={e => {
            setMeasureUnit(e.target.value)
            lsSet('measureUnit', e.target.value)
          }}
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <option value="metric">Metric</option>
          <option value="imperial">Imperial</option>
        </select>
      </SettingRow>

      {/* Auto media search */}
      <SettingRow
        title="Auto video & image search"
        description="Automatically search for relevant images and videos."
        inline
      >
        <Switch
          checked={autoMedia}
          onCheckedChange={v => toggle('autoMediaSearch', v, setAutoMedia)}
        />
      </SettingRow>

      {/* Weather widget */}
      <SettingRow
        title="Show weather widget"
        description="Display the weather card on the home screen."
        inline
      >
        <Switch
          checked={showWeather}
          onCheckedChange={v => toggle('showWeatherWidget', v, setShowWeather)}
        />
      </SettingRow>

      {/* News widget */}
      <SettingRow
        title="Show news widget"
        description="Display the recent news card on the home screen."
        inline
      >
        <Switch
          checked={showNews}
          onCheckedChange={v => toggle('showNewsWidget', v, setShowNews)}
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
  const savedRef = useRef(false)

  useEffect(() => {
    setInstructions(lsGet('systemInstructions') ?? '')
  }, [])

  const handleBlur = () => {
    lsSet('systemInstructions', instructions)
    savedRef.current = true
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingRow
        title="System Instructions"
        description='Add custom behavior or tone for the model. e.g. "Respond in a friendly and concise tone" or "Use British English and format answers as bullet points."'
      >
        <Textarea
          value={instructions}
          onChange={e => setInstructions(e.target.value)}
          onBlur={handleBlur}
          placeholder='e.g., "Respond in a friendly and concise tone" or "Use British English and format answers as bullet points."'
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
    <div className="flex flex-col gap-4">
      <SettingRow
        title="Chat Model"
        description="Use the model selector on the search bar to choose your active chat model. Models are served via Ollama."
      >
        <p className="text-xs text-muted-foreground">
          Configured via <code className="bg-muted px-1 rounded text-xs">OLLAMA_BASE_URL</code> in <code className="bg-muted px-1 rounded text-xs">.env</code>.
        </p>
      </SettingRow>

      <SettingRow
        title="Ollama Server"
        description="Native Ollama API — no API key required. Cloud models are listed via OLLAMA_MODELS."
      >
        <code className="text-xs bg-muted px-2 py-1 rounded border border-border block">
          {ollamaBase}
        </code>
      </SettingRow>

      <SettingRow
        title="Embedding Model"
        description="Used for semantic search over uploaded files (RAG). Pull a model in Ollama first, then set OLLAMA_EMBED_MODEL in .env."
      >
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">
            Recommended: <code className="bg-muted px-1 rounded">nomic-embed-text</code> (137 MB) or <code className="bg-muted px-1 rounded">mxbai-embed-large</code> (670 MB)
          </p>
          <p className="text-xs text-muted-foreground">
            Pull with: <code className="bg-muted px-1 rounded">ollama pull nomic-embed-text</code>
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
    <div className="flex flex-col gap-4">
      <SettingRow
        title="SearXNG URL"
        description="The URL of your SearXNG instance used for web search."
      >
        <code className="text-xs bg-muted px-2 py-1 rounded border border-border block">
          {searxngUrl}
        </code>
      </SettingRow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared layout component
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
    <div className={cn(
      'rounded-xl border border-border/60 bg-card p-4 flex gap-4',
      inline ? 'items-center justify-between' : 'flex-col'
    )}>
      <div className="flex flex-col gap-0.5 min-w-0">
        <p className="text-sm font-medium leading-none">{title}</p>
        <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
      </div>
      <div className={cn('shrink-0', !inline && 'w-full')}>{children}</div>
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0 gap-0 overflow-hidden">
        <div className="flex h-[560px]">
          {/* Sidebar */}
          <div className="w-44 shrink-0 border-r border-border/60 flex flex-col bg-muted/30 p-3 gap-1">
            <DialogHeader className="mb-2 px-1">
              <DialogTitle className="text-sm font-semibold flex items-center gap-2">
                <IconSettings className="size-4" />
                Settings
              </DialogTitle>
            </DialogHeader>
            {TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left',
                  activeTab === key
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                )}
              >
                <Icon className="size-4 shrink-0" />
                {label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-5">
            {activeTab === 'preferences' && <PreferencesTab />}
            {activeTab === 'personalization' && <PersonalizationTab />}
            {activeTab === 'models' && <ModelsTab />}
            {activeTab === 'search' && <SearchTab />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
