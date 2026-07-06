'use client'

import { useEffect, useSyncExternalStore } from 'react'

import { FOCUS_MODE_CONFIGS } from '@/lib/config/focus-modes'
import { FocusMode } from '@/lib/types/search'
import { cn } from '@/lib/utils'
import {
  getCookie,
  setCookie,
  subscribeToCookieChange
} from '@/lib/utils/cookies'

import { HoverCard, HoverCardContent, HoverCardTrigger } from './ui/hover-card'

const VALID_FOCUS_MODES = new Set<string>(['auto', 'academic', 'discussions'])

function getFocusModeSnapshot(): FocusMode {
  const saved = getCookie('focusMode')
  return (saved && VALID_FOCUS_MODES.has(saved) ? saved : 'auto') as FocusMode
}

export function FocusModeSelector() {
  const value = useSyncExternalStore(
    subscribeToCookieChange,
    getFocusModeSnapshot,
    () => 'auto' as FocusMode
  )

  useEffect(() => {
    const saved = getCookie('focusMode')
    if (saved && !VALID_FOCUS_MODES.has(saved)) {
      setCookie('focusMode', 'auto')
    }
  }, [])

  const selectedIndex = Math.max(
    FOCUS_MODE_CONFIGS.findIndex(c => c.value === value),
    0
  )
  const modeCount = FOCUS_MODE_CONFIGS.length

  return (
    <div className="relative inline-flex items-center rounded-full bg-background border p-1">
      {/* Sliding background indicator */}
      <div
        className="absolute inset-1 rounded-full bg-muted transition-[transform,width] duration-[180ms] ease-[var(--motion-ease-in-out)]"
        style={{
          width: `calc(${100 / modeCount}% - 4px)`,
          transform: `translateX(${selectedIndex * 100}%)`
        }}
      />

      <div className="relative flex items-center">
        {FOCUS_MODE_CONFIGS.map(config => {
          const Icon = config.icon
          const isSelected = value === config.value

          return (
            <HoverCard key={config.value} openDelay={100} closeDelay={50}>
              <HoverCardTrigger asChild>
                <button
                  type="button"
                  onClick={() => setCookie('focusMode', config.value)}
                  className={cn(
                    'relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-2 transition-colors duration-[140ms] ease-[var(--motion-ease-out)]',
                    isSelected
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground/80'
                  )}
                  aria-label={`${config.label} focus`}
                  aria-pressed={isSelected}
                >
                  <Icon
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 transition-colors',
                      isSelected ? config.color : ''
                    )}
                  />
                  <span className="text-xs font-medium">{config.label}</span>
                </button>
              </HoverCardTrigger>

              <HoverCardContent className="w-64" align="center" sideOffset={8}>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Icon className={cn('size-5', config.color)} />
                    <h4 className="text-sm font-semibold">{config.label}</h4>
                  </div>
                  <p className="text-xs text-muted-foreground leading-tight">
                    {config.description}
                  </p>
                </div>
              </HoverCardContent>
            </HoverCard>
          )
        })}
      </div>
    </div>
  )
}
