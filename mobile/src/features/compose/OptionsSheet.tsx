// The composer's options: search mode, sources and the answering model.
// Mode and sources belong to the caller (they ride on each chat request);
// the model is the signed-in user's saved preference on the server, so the
// sheet loads and saves it itself.

import { useEffect, useId, useRef, useState } from 'react'

import { useApi } from '@/core/api/ApiProvider'
import { Sheet } from '@/core/ui/Sheet'
import { fetchModels, modelKey, saveModel } from '@/features/compose/models'
import type { SearchSettings } from '@/features/thread/chat-body'
import type { ModelSelectorData } from '@/lib/types/model-selector'
import type { Model } from '@/lib/types/models'
import type { SearchMode, SourceMode } from '@/lib/types/search'

export const MODEL_LOAD_ERROR = 'Couldn’t load the models.'
export const MODEL_SAVE_ERROR = 'Couldn’t change the model. Try again.'

/** The search modes, in the order the sheet lists them. */
export const SEARCH_MODES: { value: SearchMode; label: string }[] = [
  { value: 'speed', label: 'Speed' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'quality', label: 'Quality' }
]

const SOURCES: { value: SourceMode; label: string }[] = [
  { value: 'web', label: 'Web' },
  { value: 'academic', label: 'Academic' },
  { value: 'social', label: 'Social' }
]

const SECTION_TITLE =
  'px-4 pb-2 text-xs font-medium uppercase tracking-wide text-foreground/50'
const GROUP = 'rounded-2xl bg-foreground/5'

export type OptionsSheetProps = {
  open: boolean
  onClose: () => void
  settings: SearchSettings
  onSettings: (settings: SearchSettings) => void
}

export function OptionsSheet({
  open,
  onClose,
  settings,
  onSettings
}: OptionsSheetProps) {
  const modeLabel = useId()
  const setMode = (searchMode: SearchMode) => {
    if (searchMode !== settings.searchMode)
      onSettings({ ...settings, searchMode })
  }

  const toggleSource = (source: SourceMode) => {
    const on = settings.sources.includes(source)
    // At least one source always stays on.
    if (on && settings.sources.length === 1) return
    const sources = SOURCES.map(s => s.value).filter(s =>
      s === source ? !on : settings.sources.includes(s)
    )
    onSettings({ ...settings, sources })
  }

  return (
    <Sheet open={open} onClose={onClose} title="Options">
      <div className="flex flex-col gap-6 pb-2">
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

        <ModelSection />
      </div>
    </Sheet>
  )
}

/**
 * The model picker. The sheet mounts it only while open, so each opening
 * loads the list afresh and starts with no old error.
 */
function ModelSection() {
  const { client } = useApi()
  const modelLabel = useId()
  const [data, setData] = useState<ModelSelectorData | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [selected, setSelected] = useState('')
  const [saveFailed, setSaveFailed] = useState(false)
  // The pick the server last confirmed: what a failed save puts back.
  const saved = useRef('')
  // One save at a time, so responses can't arrive out of order: a pick made
  // while one is in flight waits here, and only the newest waiting pick is
  // sent when it settles.
  const inFlight = useRef(false)
  const waiting = useRef<Model | null>(null)

  useEffect(() => {
    let live = true
    fetchModels(client).then(
      result => {
        if (!live) return
        saved.current = result.selectedModelKey
        setSelected(result.selectedModelKey)
        setData(result)
      },
      () => {
        if (live) setLoadFailed(true)
      }
    )
    return () => {
      live = false
    }
  }, [client])

  if (loadFailed) {
    return <p className="px-4 text-sm text-foreground/60">{MODEL_LOAD_ERROR}</p>
  }
  if (!data) {
    return <p className="px-4 text-sm text-foreground/60">Loading models…</p>
  }
  if (!data.enabled || !data.hasAvailableModels) return null

  const send = (model: Model) => {
    inFlight.current = true
    saveModel(client, model.providerId, model.id).then(
      confirmed => {
        saved.current = confirmed
        settle(true)
      },
      () => settle(false)
    )
  }

  // Sends the newest waiting pick, unless the server already holds it;
  // otherwise shows what the server holds, and the error if the last save
  // failed.
  const settle = (ok: boolean) => {
    const next = waiting.current
    waiting.current = null
    if (next && modelKey(next) !== saved.current) return send(next)
    inFlight.current = false
    setSelected(saved.current)
    setSaveFailed(!ok && !next)
  }

  const pick = (model: Model) => {
    const key = modelKey(model)
    if (key === selected) return
    setSelected(key)
    setSaveFailed(false)
    if (inFlight.current) waiting.current = model
    else send(model)
  }

  const providers = Object.entries(data.modelsByProvider).sort(([a], [b]) =>
    a.localeCompare(b)
  )

  return (
    <section>
      <h3 id={modelLabel} className={SECTION_TITLE}>
        Model
      </h3>
      {saveFailed && (
        <p role="alert" className="px-4 pb-2 text-sm text-red-500">
          {MODEL_SAVE_ERROR}
        </p>
      )}
      <div
        role="radiogroup"
        aria-labelledby={modelLabel}
        className="flex flex-col gap-3"
      >
        {providers.map(([provider, models]) => (
          <div key={provider}>
            <h4 className="px-4 pb-1 text-xs text-foreground/50">{provider}</h4>
            <div className={`${GROUP} overflow-hidden`}>
              {models.map(model => {
                const checked = modelKey(model) === selected
                return (
                  <button
                    key={modelKey(model)}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    onClick={() => pick(model)}
                    className="flex min-h-11 w-full touch-manipulation items-center gap-3 px-4 text-left text-base active:opacity-50"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {model.name}
                    </span>
                    {checked && (
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="size-5 shrink-0 text-mark-blue"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M5 12.5l4.5 4.5L19 7.5" />
                      </svg>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
