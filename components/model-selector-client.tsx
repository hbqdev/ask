'use client'

import { useMemo, useState } from 'react'

import {
  IconChevronDown as ChevronDown,
  IconCpu as Cpu
} from '@tabler/icons-react'

import { saveModelPreference } from '@/lib/actions/model-preference'
import {
  MODEL_SELECTION_COOKIE,
  serializeModelSelectionCookie
} from '@/lib/config/model-selection-cookie'
import { ModelSelectorData } from '@/lib/types/model-selector'
import { Model } from '@/lib/types/models'
import { cn } from '@/lib/utils'
import { setCookie } from '@/lib/utils/cookies'

import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

function modelKey(model: Model): string {
  return `${model.providerId}:${model.id}`
}

interface ModelSelectorClientProps {
  data: ModelSelectorData
}

export function ModelSelectorClient({ data }: ModelSelectorClientProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedModelKey, setSelectedModelKey] = useState<string>(
    data.selectedModelKey
  )

  const providerEntries = useMemo(
    () =>
      Object.entries(data.modelsByProvider).sort(([a], [b]) =>
        a.localeCompare(b)
      ),
    [data.modelsByProvider]
  )

  const selectableModels = useMemo(
    () => providerEntries.flatMap(([, models]) => models),
    [providerEntries]
  )

  const selectableByKey = useMemo(
    () =>
      Object.fromEntries(
        selectableModels.map(model => [modelKey(model), model])
      ) as Record<string, Model>,
    [selectableModels]
  )

  const selectedModel = selectableByKey[selectedModelKey]

  const filteredEntries = useMemo(() => {
    if (!search) return providerEntries
    const q = search.toLowerCase()
    return providerEntries
      .map(
        ([provider, models]) =>
          [
            provider,
            models.filter(
              m =>
                m.name.toLowerCase().includes(q) ||
                provider.toLowerCase().includes(q)
            )
          ] as [string, Model[]]
      )
      .filter(([, models]) => models.length > 0)
  }, [providerEntries, search])

  if (!data.enabled) return null

  if (!data.hasAvailableModels) {
    return (
      <Button
        variant="outline"
        className="h-auto gap-1 rounded-full border-none bg-muted px-3 py-2 text-sm shadow-none"
        disabled
        title="No enabled models are available"
      >
        <span className="truncate max-w-52 text-xs font-medium">
          No enabled model available
        </span>
      </Button>
    )
  }

  if (!selectedModel) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-auto gap-1 rounded-full border-none bg-muted px-3 py-2 text-sm shadow-none transition-[background-color,color,box-shadow,transform]"
        >
          <Cpu className="size-3.5 text-sky-500 shrink-0" />
          <span className="truncate max-w-40 text-xs font-medium">
            {selectedModel.name}
          </span>
          <ChevronDown
            className={cn(
              'ml-0.5 h-3 w-3 opacity-50 transition-transform duration-[160ms] ease-[var(--motion-ease-out)]',
              open && 'rotate-180'
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[280px] p-0 overflow-hidden"
        align="end"
        sideOffset={6}
      >
        {/* Search */}
        <div className="p-2 border-b border-border/50">
          <div className="relative">
            <svg
              className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="text"
              placeholder="Search models..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-muted rounded-md placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
        </div>

        {/* Model list */}
        <div className="max-h-[280px] overflow-y-auto">
          {filteredEntries.length === 0 ? (
            <p className="text-center py-6 text-xs text-muted-foreground">
              No model found.
            </p>
          ) : (
            filteredEntries.map(([provider, models], providerIndex) => (
              <div key={provider}>
                {/* Provider header — ALL CAPS, muted, sticky */}
                <div className="px-3 py-2 sticky top-0 bg-popover border-b border-border/40">
                  <p className="text-[10px] font-medium tracking-wider uppercase text-muted-foreground">
                    {provider}
                  </p>
                </div>

                <div className="px-1.5 py-1.5 space-y-0.5">
                  {models.map(model => {
                    const value = modelKey(model)
                    const isSelected = selectedModelKey === value
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => {
                          const nextModel = selectableByKey[value]
                          if (!nextModel) return
                          setSelectedModelKey(value)
                          setCookie(
                            MODEL_SELECTION_COOKIE,
                            serializeModelSelectionCookie({
                              providerId: nextModel.providerId,
                              modelId: nextModel.id
                            })
                          )
                          // Remember the explicit pick on the account too
                          // (fire-and-forget; guests no-op server-side).
                          void saveModelPreference(
                            nextModel.providerId,
                            nextModel.id
                          ).catch(() => {})
                          setOpen(false)
                        }}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors duration-150 cursor-pointer',
                          isSelected ? 'bg-muted' : 'hover:bg-muted/60'
                        )}
                      >
                        <Cpu
                          className={cn(
                            'size-3.5 shrink-0',
                            isSelected
                              ? 'text-sky-500'
                              : 'text-muted-foreground'
                          )}
                        />
                        <span
                          className={cn(
                            'text-xs truncate',
                            isSelected
                              ? 'text-sky-500 font-medium'
                              : 'text-foreground/70'
                          )}
                        >
                          {model.name}
                        </span>
                      </button>
                    )
                  })}
                </div>

                {providerIndex < filteredEntries.length - 1 && (
                  <div className="h-px bg-border/40 mx-3" />
                )}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
