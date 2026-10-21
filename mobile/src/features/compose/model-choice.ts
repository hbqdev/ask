// The user's model pick, shared by every ModelPicker (the composer's options
// sheet and Settings), so they agree on the checked model and their saves go
// through one queue: one save at a time, so responses can't arrive out of
// order, and a pick made while one is in flight waits; only the newest
// waiting pick is sent when it settles. A save keeps going after the picker
// that started it closes.

import type { ApiClient } from '@/core/api/client'
import { modelKey, saveModel } from '@/features/compose/models'
import type { Model } from '@/lib/types/models'

/** What a picker shows: the checked model's key and the save error. */
export type ModelChoiceView = { selected: string; saveFailed: boolean }

type State = {
  view: ModelChoiceView
  /** The pick the server last confirmed: what a failed save puts back. */
  saved: string
  inFlight: boolean
  waiting: { client: ApiClient; model: Model } | null
  /** Counts picks, so a list load can tell one was made while it ran. */
  picks: number
}

const initial = (): State => ({
  view: { selected: '', saveFailed: false },
  saved: '',
  inFlight: false,
  waiting: null,
  picks: 0
})

let state = initial()
// Bumped by reset, so a save answered after it changes nothing.
let epoch = 0
const listeners = new Set<() => void>()

function show(view: ModelChoiceView) {
  state.view = view
  for (const listener of [...listeners]) listener()
}

/** Subscribes `fn` to changes of the view; returns the unsubscribe. */
export function subscribeModelChoice(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** The current view (a stable object between changes). */
export function getModelChoice(): ModelChoiceView {
  return state.view
}

/** A mark taken when a list load starts; pass it to modelListLoaded. */
export function modelListMark(): number {
  return state.picks
}

/**
 * The server's pick from a list load started at `mark`. It is ignored when a
 * pick was made since (the load may predate that pick's save) or a save is
 * in flight (which settles the pick itself). Otherwise it is shown, and an
 * old save error is cleared.
 */
export function modelListLoaded(selectedModelKey: string, mark: number): void {
  if (state.inFlight || state.picks !== mark) return
  state.saved = selectedModelKey
  show({ selected: selectedModelKey, saveFailed: false })
}

function send(client: ApiClient, model: Model) {
  const mine = epoch
  state.inFlight = true
  saveModel(client, model.providerId, model.id).then(
    confirmed => {
      if (mine !== epoch) return
      state.saved = confirmed
      settle(true)
    },
    () => {
      if (mine === epoch) settle(false)
    }
  )
}

// Sends the newest waiting pick, unless the server already holds it;
// otherwise shows what the server holds, and the error if the last save
// failed.
function settle(ok: boolean) {
  const next = state.waiting
  state.waiting = null
  if (next && modelKey(next.model) !== state.saved) {
    return send(next.client, next.model)
  }
  state.inFlight = false
  show({ selected: state.saved, saveFailed: !ok && !next })
}

/** Checks `model` at once and saves it, queued behind a save in flight. */
export function pickModel(client: ApiClient, model: Model): void {
  const key = modelKey(model)
  if (key === state.view.selected) return
  state.picks++
  show({ selected: key, saveFailed: false })
  if (state.inFlight) state.waiting = { client, model }
  else send(client, model)
}

/** Forgets everything, including saves in flight (tests). */
export function resetModelChoice(): void {
  epoch++
  state = initial()
  for (const listener of [...listeners]) listener()
}
