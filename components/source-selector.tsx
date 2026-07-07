'use client'

import { useState, useSyncExternalStore } from 'react'

import { IconChevronDown, IconGlobe } from '@tabler/icons-react'

import { SOURCE_MODE_CONFIGS } from '@/lib/config/source-modes'
import { SearchSources, SourceMode } from '@/lib/types/search'
import { cn } from '@/lib/utils'
import {
  getCookie,
  setCookie,
  subscribeToCookieChange
} from '@/lib/utils/cookies'

import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Switch } from './ui/switch'

const DEFAULT_SOURCES: SearchSources = ['web']
let _cachedRaw: string | null | undefined = undefined
let _cachedSources: SearchSources = DEFAULT_SOURCES

function getSourcesSnapshot(): SearchSources {
  const raw = getCookie('sources')
  if (raw === _cachedRaw) return _cachedSources
  _cachedRaw = raw
  try {
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        _cachedSources = parsed as SearchSources
        return _cachedSources
      }
    }
  } catch {
    // ignore parse errors
  }
  _cachedSources = DEFAULT_SOURCES
  return _cachedSources
}

function setSourcesCookie(sources: SearchSources) {
  setCookie('sources', JSON.stringify(sources))
}

export function SourceSelector() {
  const [open, setOpen] = useState(false)
  const sources = useSyncExternalStore(
    subscribeToCookieChange,
    getSourcesSnapshot,
    () => ['web'] as SearchSources
  )

  const toggleSource = (source: SourceMode) => {
    if (source === 'web') return // web always stays on
    const hasSource = sources.includes(source)
    if (hasSource) {
      const newSources = sources.filter(s => s !== source)
      setSourcesCookie(newSources.length === 0 ? ['web'] : newSources)
    } else {
      setSourcesCookie([...sources, source] as SearchSources)
    }
  }

  // Label for trigger button
  const extraCount = sources.filter(s => s !== 'web').length
  const triggerLabel = extraCount > 0 ? `Web +${extraCount}` : 'Web'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-xs font-medium',
            'text-muted-foreground hover:text-foreground transition-colors',
            open && 'text-foreground'
          )}
        >
          <IconGlobe className="size-3.5 text-sky-500" />
          <span>{triggerLabel}</span>
          <IconChevronDown
            className={cn(
              'size-3 opacity-50 transition-transform',
              open && 'rotate-180'
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start" sideOffset={8}>
        <div className="space-y-1">
          {SOURCE_MODE_CONFIGS.map(config => {
            const Icon = config.icon
            const isActive = sources.includes(config.value)
            const isWeb = config.value === 'web'
            return (
              <div
                key={config.value}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5',
                  !isWeb && 'cursor-pointer hover:bg-muted/50'
                )}
                onClick={() => !isWeb && toggleSource(config.value)}
              >
                <Icon className={cn('size-4 shrink-0', config.color)} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{config.label}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {config.description}
                  </div>
                </div>
                <Switch
                  checked={isActive}
                  onCheckedChange={() => !isWeb && toggleSource(config.value)}
                  disabled={isWeb}
                  onClick={e => e.stopPropagation()}
                  className="shrink-0"
                />
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
