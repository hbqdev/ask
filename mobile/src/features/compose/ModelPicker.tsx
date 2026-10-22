// The answering model picker: the models the server offers, grouped by
// provider, with the signed-in user's pick checked. The pick is the user's
// saved preference on the server, so the picker loads and saves it itself,
// through one store every picker shares (model-choice.ts). Used by the
// composer's options sheet and by Settings.

import { useEffect, useId, useState, useSyncExternalStore } from 'react'

import { useTabActive } from '@/app/Tabs'
import { useApi } from '@/core/api/ApiProvider'
import { haptic } from '@/core/haptics'
import { SECTION_TITLE } from '@/core/ui/classes'
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

const GROUP = 'rounded-2xl bg-card'

/**
 * The model picker. It loads the list when it mounts and again each time its
 * tab is shown (the pick may have changed elsewhere meanwhile), keeping the
 * list it has while a reload is on its way.
 */
export function ModelPicker() {
  const { client } = useApi()
  const active = useTabActive()
  const modelLabel = useId()
  const [data, setData] = useState<ModelSelectorData | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
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
      },
      () => {
        if (live) setLoadFailed(true)
      }
    )
    return () => {
      live = false
    }
  }, [client, active])

  if (!data) {
    return (
      <p className="px-4 text-sm text-foreground/60">
        {loadFailed ? MODEL_LOAD_ERROR : 'Loading models…'}
      </p>
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
