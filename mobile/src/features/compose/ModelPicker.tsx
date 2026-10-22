// The answering model picker: the models the server offers, grouped by
// provider, with the signed-in user's pick checked. The pick is the user's
// saved preference on the server, so the picker loads and saves it itself,
// through one store every picker shares (model-choice.ts). Used by the
// composer's options sheet and by Settings.

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'

import { useTabActive } from '@/app/Tabs'
import { useApi } from '@/core/api/ApiProvider'
import { haptic } from '@/core/haptics'
import { GROUP, SECTION_TITLE } from '@/core/ui/classes'
import {
  getModelChoice,
  modelListLoaded,
  modelListMark,
  pickModel,
  subscribeModelChoice
} from '@/features/compose/model-choice'
import { fetchModels, modelKey } from '@/features/compose/models'
import type { ModelSelectorData } from '@/lib/types/model-selector'

export const MODEL_LOAD_ERROR = 'Couldn’t load the models.'
export const MODEL_SAVE_ERROR = 'Couldn’t change the model. Try again.'

/**
 * The model picker. It loads the list when it mounts and again each time its
 * tab is shown (the pick may have changed elsewhere meanwhile), keeping the
 * list it has while a reload is on its way. A list that failed to load offers
 * Retry. With `revealChecked` (the composer's options sheet), the checked
 * model is scrolled into view when the list first shows, as a long list in a
 * sheet would hide it; Settings leaves its page at the top.
 */
export function ModelPicker({
  revealChecked = false
}: {
  /** Scroll the checked model into view once, when the list first shows. */
  revealChecked?: boolean
}) {
  const { client } = useApi()
  const active = useTabActive()
  const modelLabel = useId()
  const [data, setData] = useState<ModelSelectorData | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  // Bumped by Retry, to run the load again.
  const [attempt, setAttempt] = useState(0)
  // A Retry is on its way: the failure row stays, saying so.
  const [retrying, setRetrying] = useState(false)
  const group = useRef<HTMLDivElement>(null)
  const scrolled = useRef(false)
  const { selected, saveFailed } = useSyncExternalStore(
    subscribeModelChoice,
    getModelChoice
  )

  useEffect(() => {
    if (!active) return
    let live = true
    // A pick made while the list loads wins over the key the list carries.
    const mark = modelListMark()
    fetchModels(client).then(
      result => {
        if (!live) return
        modelListLoaded(result.selectedModelKey, mark)
        setData(result)
        setLoadFailed(false)
        setRetrying(false)
      },
      () => {
        if (!live) return
        setLoadFailed(true)
        setRetrying(false)
      }
    )
    return () => {
      live = false
    }
  }, [client, active, attempt])

  // Once, when the list first shows: the checked model into view.
  useEffect(() => {
    if (!revealChecked || !data || scrolled.current) return
    scrolled.current = true
    group.current
      ?.querySelector<HTMLElement>('[aria-checked="true"]')
      // Missing where there is no layout (jsdom).
      ?.scrollIntoView?.({ block: 'center' })
  }, [revealChecked, data])

  if (!data) {
    if (!loadFailed) {
      return <p className="px-4 text-sm text-foreground/60">Loading models…</p>
    }
    // The row and its button stay while a Retry loads, so focus and
    // VoiceOver keep their place; the changed line is announced.
    return (
      <div role="alert" className="flex items-center gap-3 px-4">
        <p className="flex-1 text-sm text-foreground/60">
          {retrying ? 'Loading models…' : MODEL_LOAD_ERROR}
        </p>
        <button
          type="button"
          aria-disabled={retrying}
          onClick={() => {
            if (retrying) return
            setRetrying(true)
            setAttempt(a => a + 1)
          }}
          className="min-h-11 touch-manipulation px-2 text-sm font-semibold text-accent active:opacity-50 aria-disabled:opacity-50"
        >
          Retry
        </button>
      </div>
    )
  }
  if (!data.enabled || !data.hasAvailableModels) return null

  const providers = Object.entries(data.modelsByProvider).sort(([a], [b]) =>
    a.localeCompare(b)
  )

  return (
    <section>
      <h3 id={modelLabel} className={SECTION_TITLE}>
        Model
      </h3>
      {saveFailed && (
        <p role="alert" className="px-4 pb-2 text-sm text-destructive">
          {MODEL_SAVE_ERROR}
        </p>
      )}
      <div
        ref={group}
        role="radiogroup"
        aria-labelledby={modelLabel}
        className="flex flex-col gap-3"
      >
        {providers.map(([provider, models]) => (
          <div key={provider}>
            <h4 className="px-4 pb-1 text-xs text-foreground/60">{provider}</h4>
            <div className={`${GROUP} overflow-hidden`}>
              {models.map(model => {
                const checked = modelKey(model) === selected
                return (
                  <button
                    key={modelKey(model)}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    onClick={() => {
                      if (checked) return
                      haptic('selection')
                      pickModel(client, model)
                    }}
                    className="flex min-h-11 w-full touch-manipulation items-center gap-3 px-4 text-left text-base active:opacity-50"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {model.name}
                    </span>
                    {checked && (
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="size-5 shrink-0 text-accent"
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
