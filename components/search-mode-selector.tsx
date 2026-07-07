'use client'

import { useState, useSyncExternalStore } from 'react'

import {
  IconCheck as Check,
  IconChevronDown as ChevronDown
} from '@tabler/icons-react'

import { SEARCH_MODE_CONFIGS } from '@/lib/config/search-modes'
import { SearchMode } from '@/lib/types/search'
import { cn } from '@/lib/utils'
import {
  getCookie,
  setCookie,
  subscribeToCookieChange
} from '@/lib/utils/cookies'

import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

const VALID_SEARCH_MODES = new Set<string>(['speed', 'balanced', 'quality'])

function getSearchModeSnapshot(): SearchMode {
  const savedMode = getCookie('searchMode')
  // Backward compat: map old cookie values to new ones
  if (savedMode === 'quick') return 'speed'
  if (savedMode === 'adaptive') return 'balanced'
  if (savedMode && VALID_SEARCH_MODES.has(savedMode))
    return savedMode as SearchMode
  return 'balanced'
}

interface SearchModeSelectorProps {
  isAdaptiveAuthRequired?: boolean
  onAdaptiveAuthRequired?: () => void
}

export function SearchModeSelector({
  isAdaptiveAuthRequired = false,
  onAdaptiveAuthRequired
}: SearchModeSelectorProps) {
  const value = useSyncExternalStore(
    subscribeToCookieChange,
    getSearchModeSnapshot,
    () => 'balanced' as SearchMode
  )
  const [open, setOpen] = useState(false)

  const handleModeSelect = (mode: SearchMode) => {
    if (mode === 'quality' && isAdaptiveAuthRequired) {
      setCookie('searchMode', 'balanced')
      setOpen(false)
      onAdaptiveAuthRequired?.()
      return
    }

    setCookie('searchMode', mode)
    setOpen(false)
  }

  const selectedMode = SEARCH_MODE_CONFIGS.find(
    config => config.value === value
  )
  const SelectedIcon = selectedMode?.icon

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-xs font-medium shadow-none',
            'transition-[background-color,color,box-shadow,transform]',
            'hover:bg-muted focus:outline-none'
          )}
          aria-label="Select search mode"
        >
          {SelectedIcon && (
            <SelectedIcon
              className={cn(
                'size-3.5 shrink-0 transition-colors',
                selectedMode?.color
              )}
            />
          )}
          <span>{selectedMode?.label}</span>
          <ChevronDown
            className={cn(
              'ml-0.5 size-3 opacity-50 transition-transform duration-[160ms] ease-[var(--motion-ease-out)]',
              open && 'rotate-180'
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-1"
        align="start"
        sideOffset={6}
      >
        {SEARCH_MODE_CONFIGS.map(config => {
          const ModeIcon = config.icon
          const isSelected = value === config.value

          return (
            <button
              key={config.value}
              type="button"
              onClick={() => handleModeSelect(config.value)}
              className={cn(
                'flex w-full items-start gap-3 rounded-sm px-3 py-2.5 text-left',
                'transition-colors hover:bg-muted focus:outline-none',
                isSelected && 'bg-muted/50'
              )}
            >
              <ModeIcon
                className={cn('mt-0.5 size-4 shrink-0', config.color)}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold leading-tight">
                  {config.label}
                </div>
                <div className="mt-0.5 text-xs leading-snug text-muted-foreground">
                  {config.description}
                </div>
              </div>
              {isSelected && (
                <Check className="mt-0.5 size-4 shrink-0 text-foreground" />
              )}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
