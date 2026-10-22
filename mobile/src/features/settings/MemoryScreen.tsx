// Memory, pushed from Settings: the switches for memory and for recall of
// past chats, the recall index (its size, Rebuild and Clear), and what Ask
// remembers (tap one to read it all, swipe to delete it, or clear them all).
//
// A rebuild runs one bounded batch per request (each can take most of a
// minute), with progress after each, and stops when the screen is left.
// Covering the screen or sending the app to the background pauses it (the
// batch in flight is dropped) until the user taps Continue. The rest of the
// screen stays usable meanwhile.

import { App } from '@capacitor/app'
import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { useApi } from '@/core/api/ApiProvider'
import { ApiError } from '@/core/api/errors'
import { haptic } from '@/core/haptics'
import { useScreenActive, useStack, type Stack } from '@/core/nav/stack'
import { ConfirmSheet } from '@/core/ui/ConfirmSheet'
import { Sheet } from '@/core/ui/Sheet'
import { SwipeRow } from '@/core/ui/SwipeRow'
import {
  categoryLabel,
  clearMemories,
  clearRecallIndex,
  deleteMemory,
  fetchMemory,
  memoryErrorText,
  rebuildErrorText,
  rebuildRecallIndex,
  refreshRecallStatus,
  saveMemorySettings,
  type Memory,
  type MemorySettings,
  type RecallStatus
} from '@/features/settings/memory-api'

export const SAVE_SETTING_ERROR = 'Couldn’t save the change.'
export const REBUILD_ERROR = 'Couldn’t rebuild the index.'
export const REBUILD_STALLED =
  'Indexing isn’t making progress. The indexing service may be down; try again later.'
export const REBUILD_STOPPED =
  'Indexing stopped after too many rounds. Try again.'
export const CLEAR_INDEX_ERROR = 'Couldn’t clear the index.'
export const DELETE_MEMORY_ERROR = 'Couldn’t delete the memory.'
export const CLEAR_MEMORIES_ERROR = 'Couldn’t clear your memories.'

/** Opens the Memory screen over the current one. */
export function openMemory(push: Stack['push']) {
  push({ key: 'settings:memory', render: () => <MemoryScreen /> })
}

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; error: string }
  | { kind: 'ready' }

type SwitchKey = keyof MemorySettings

/** A message under one part of the screen: news, or a failure. */
type Note = { tone: 'status' | 'alert'; text: string } | null

type Confirm =
  | { kind: 'clearIndex' }
  | { kind: 'clearAll' }
  | { kind: 'delete'; memory: Memory }
  | null

const BACK_ICON = 'M15 5l-7 7 7 7'

/**
 * The abort reason of a rebuild paused by the app going to the background or
 * the screen being covered.
 */
const PAUSED = Symbol('paused')

const SECTION_TITLE =
  'px-4 pb-2 text-xs font-medium uppercase tracking-wide text-foreground/50'
const GROUP = 'rounded-2xl bg-foreground/5'
const NOTE = 'px-4 pt-2 text-sm'
const PILL =
  'min-h-11 flex-1 touch-manipulation rounded-xl px-4 text-sm font-medium active:opacity-60 disabled:opacity-40'
const SHEET_BUTTON =
  'min-h-12 w-full touch-manipulation rounded-xl text-base font-medium active:opacity-50'

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

function NoteLine({ note }: { note: Note }) {
  if (!note) return null
  return (
    <p
      role={note.tone}
      className={`${NOTE} ${note.tone === 'alert' ? 'text-red-500' : 'text-foreground/60'}`}
    >
      {note.text}
    </p>
  )
}

function Switch({
  label,
  checked,
  busy,
  note,
  onToggle
}: {
  label: string
  checked: boolean
  busy: boolean
  note: string
  onToggle: () => void
}) {
  const labelId = useId()
  return (
    <div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-busy={busy || undefined}
        disabled={busy}
        onClick={onToggle}
        className={`${GROUP} flex min-h-12 w-full touch-manipulation items-center gap-3 px-4 text-left active:opacity-60`}
      >
        <span id={labelId} className="flex-1 text-base">
          {label}
        </span>
        <span
          aria-hidden="true"
          className={`flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors ${
            checked ? 'bg-mark-blue' : 'bg-foreground/20'
          }`}
        >
          <span
            className={`size-6 rounded-full bg-white shadow-sm transition-transform ${
              checked ? 'translate-x-5' : ''
            }`}
          />
        </span>
      </button>
      <p className={`${NOTE} text-foreground/50`}>{note}</p>
    </div>
  )
}

function LearningBadge() {
  return (
    <span className="rounded-full bg-mark-blue/15 px-2 py-0.5 text-[11px] font-semibold text-mark-blue">
      Learning
    </span>
  )
}

export function MemoryScreen() {
  const { pop } = useStack()
  const { client } = useApi()
  const active = useScreenActive()
  const listLabel = useId()

  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [loadNonce, setLoadNonce] = useState(0)
  const [switches, setSwitches] = useState({
    memoryEnabled: false,
    recallEnabled: false
  })
  const [saving, setSaving] = useState<Record<SwitchKey, boolean>>({
    memoryEnabled: false,
    recallEnabled: false
  })
  const [recall, setRecall] = useState<RecallStatus>({ chunks: 0, chats: 0 })
  const [memories, setMemories] = useState<Memory[]>([])
  // Deleted here and not (yet) put back: hidden from the list.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set())

  const [settingsNote, setSettingsNote] = useState<Note>(null)
  const [indexNote, setIndexNote] = useState<Note>(null)
  const [listNote, setListNote] = useState<Note>(null)

  const [rebuild, setRebuild] = useState({ running: false, batches: 0 })
  const [clearing, setClearing] = useState(false)
  const [clearingIndex, setClearingIndex] = useState(false)
  // A rebuild the app's going to the background stopped, to continue.
  const [paused, setPaused] = useState(false)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [viewing, setViewing] = useState<Memory | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchMemory(client, controller.signal).then(
      overview => {
        setSwitches({
          memoryEnabled: overview.enabled,
          recallEnabled: overview.recallEnabled
        })
        setRecall(overview.recall)
        setMemories(overview.memories)
        setRemoved(new Set())
        setLoad({ kind: 'ready' })
      },
      error => {
        if (controller.signal.aborted) return
        setLoad({ kind: 'failed', error: memoryErrorText(error) })
      }
    )
    return () => controller.abort()
  }, [client, loadNonce])

  const retry = () => {
    setLoad({ kind: 'loading' })
    setLoadNonce(n => n + 1)
  }

  // --- Switches ---

  const toggle = async (key: SwitchKey) => {
    const previous = switches[key]
    haptic('selection')
    setSettingsNote(null)
    setSwitches(s => ({ ...s, [key]: !previous }))
    setSaving(s => ({ ...s, [key]: true }))
    try {
      const stored = await saveMemorySettings(client, { [key]: !previous })
      // Only this switch: another may be saving a change of its own.
      setSwitches(s => ({
        ...s,
        [key]: key === 'memoryEnabled' ? stored.enabled : stored.recallEnabled
      }))
    } catch (error) {
      setSwitches(s => ({ ...s, [key]: previous }))
      setSettingsNote({
        tone: 'alert',
        text: `${SAVE_SETTING_ERROR} ${memoryErrorText(error)}`
      })
    } finally {
      setSaving(s => ({ ...s, [key]: false }))
    }
  }

  // --- Recall index ---

  const rebuildAbort = useRef<AbortController | null>(null)
  // Set at once on a tap and cleared when the run ends, so a second tap
  // before the re-render (or one while a stopped batch winds down) starts
  // nothing.
  const rebuilding = useRef(false)
  const stopRebuild = useCallback((reason?: typeof PAUSED) => {
    rebuildAbort.current?.abort(reason)
    rebuildAbort.current = null
  }, [])
  // Left (unmounted): stop.
  useEffect(() => () => stopRebuild(), [stopRebuild])
  // Covered: pause, to continue on the user's tap once it is shown again.
  useEffect(() => {
    if (!active) stopRebuild(PAUSED)
  }, [active, stopRebuild])
  // To the background: pause, so the batch is not cut off mid-way by iOS.
  useEffect(() => {
    const handle = App.addListener('pause', () => stopRebuild(PAUSED))
    return () => void handle.then(h => h.remove())
  }, [stopRebuild])

  const startRebuild = async () => {
    if (rebuilding.current) return
    rebuilding.current = true
    const controller = new AbortController()
    rebuildAbort.current = controller
    setIndexNote(null)
    setPaused(false)
    setRebuild({ running: true, batches: 0 })
    try {
      const outcome = await rebuildRecallIndex(client, {
        signal: controller.signal,
        onBatch: async () => {
          setRebuild(r => ({ ...r, batches: r.batches + 1 }))
          // The index's new size; a failed (or timed-out) refresh only
          // leaves the old one.
          await refreshRecallStatus(client, {
            signal: controller.signal
          }).then(setRecall, () => {})
        }
      })
      if (outcome.kind === 'done') {
        haptic('success')
        setIndexNote({
          tone: 'status',
          text:
            outcome.messages > 0
              ? `Indexed ${outcome.messages} messages.`
              : 'The index is already up to date.'
        })
      } else {
        setIndexNote({
          tone: 'alert',
          text: outcome.kind === 'stalled' ? REBUILD_STALLED : REBUILD_STOPPED
        })
      }
    } catch (error) {
      // Paused: the user continues it. Stopped by leaving: nothing to say.
      if (controller.signal.reason === PAUSED) {
        setPaused(true)
      } else if (!controller.signal.aborted) {
        setIndexNote({
          tone: 'alert',
          text: `${REBUILD_ERROR} ${rebuildErrorText(error)}`
        })
      }
    } finally {
      if (rebuildAbort.current === controller) rebuildAbort.current = null
      rebuilding.current = false
      setRebuild({ running: false, batches: 0 })
    }
  }

  const clearIndex = async () => {
    setIndexNote(null)
    setPaused(false)
    setClearingIndex(true)
    try {
      await clearRecallIndex(client)
      setRecall({ chunks: 0, chats: 0 })
      setIndexNote({ tone: 'status', text: 'Index cleared.' })
    } catch (error) {
      setIndexNote({
        tone: 'alert',
        text: `${CLEAR_INDEX_ERROR} ${memoryErrorText(error)}`
      })
    } finally {
      setClearingIndex(false)
    }
  }

  // --- Memories ---

  const remove = async (memory: Memory) => {
    setListNote(null)
    setRemoved(r => new Set(r).add(memory.id))
    try {
      await deleteMemory(client, memory.id)
    } catch (error) {
      // Already gone on the server: that is what the user wanted.
      if (error instanceof ApiError && error.status === 404) return
      setRemoved(r => {
        const next = new Set(r)
        next.delete(memory.id)
        return next
      })
      setListNote({
        tone: 'alert',
        text: `${DELETE_MEMORY_ERROR} ${memoryErrorText(error)}`
      })
    }
  }

  const clearAll = async () => {
    setListNote(null)
    setClearing(true)
    try {
      await clearMemories(client)
      setMemories([])
      setRemoved(new Set())
      setListNote({ tone: 'status', text: 'All memories cleared.' })
    } catch (error) {
      setListNote({
        tone: 'alert',
        text: `${CLEAR_MEMORIES_ERROR} ${memoryErrorText(error)}`
      })
    } finally {
      setClearing(false)
    }
  }

  const shown = memories.filter(m => !removed.has(m.id))

  const header = (
    <header className="grid grid-cols-[3rem_minmax(0,1fr)_3rem] items-center border-b border-foreground/10 px-1 py-1">
      <button
        type="button"
        aria-label="Back"
        onClick={pop}
        className="flex size-11 touch-manipulation items-center justify-center rounded-full text-foreground/70 active:opacity-50"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-6"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={BACK_ICON} />
        </svg>
      </button>
      <h1 className="truncate text-center text-base font-semibold">Memory</h1>
    </header>
  )

  let body
  if (load.kind === 'loading') {
    body = (
      <div
        role="status"
        aria-label="Loading memory"
        className="flex animate-pulse flex-col gap-3 px-4 pt-6"
      >
        <div className="h-12 rounded-2xl bg-foreground/8" />
        <div className="h-12 rounded-2xl bg-foreground/8" />
        <div className="h-24 rounded-2xl bg-foreground/8" />
      </div>
    )
  } else if (load.kind === 'failed') {
    body = (
      <div
        role="alert"
        className="flex flex-col items-center gap-3 px-8 pt-16 text-center"
      >
        <p className="text-lg font-semibold">Couldn’t load your memory</p>
        <p className="text-sm text-muted-foreground">{load.error}</p>
        <button
          type="button"
          onClick={retry}
          className="min-h-11 touch-manipulation rounded-full bg-foreground px-4 text-sm font-semibold text-background active:opacity-50"
        >
          Retry
        </button>
      </div>
    )
  } else {
    const indexStatus =
      recall.chats === 0 && recall.chunks === 0
        ? 'No chats indexed yet'
        : `${plural(recall.chats, 'chat', 'chats')} indexed`
    body = (
      <div className="flex flex-col gap-8 px-4 pt-6 pb-8">
        <section className="flex flex-col gap-5">
          <Switch
            label="Remember things about me"
            checked={switches.memoryEnabled}
            busy={saving.memoryEnabled}
            note="Ask keeps useful details from your chats. Turning this off stops it learning; what it already remembers stays until you delete it."
            onToggle={() => void toggle('memoryEnabled')}
          />
          <Switch
            label="Use past chats"
            checked={switches.recallEnabled}
            busy={saving.recallEnabled}
            note="Ask searches your past chats when they help with a question."
            onToggle={() => void toggle('recallEnabled')}
          />
          <NoteLine note={settingsNote} />
        </section>

        <section>
          <h2 className={SECTION_TITLE}>Past-chat index</h2>
          <div className={`${GROUP} flex flex-col gap-3 p-4`}>
            <p className="text-base">{indexStatus}</p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={
                  rebuild.running || clearingIndex || !switches.recallEnabled
                }
                aria-busy={rebuild.running || undefined}
                onClick={() => void startRebuild()}
                className={`${PILL} bg-background text-foreground`}
              >
                {rebuild.running ? 'Indexing…' : 'Rebuild index'}
              </button>
              <button
                type="button"
                disabled={
                  rebuild.running || clearingIndex || recall.chunks === 0
                }
                onClick={() => setConfirm({ kind: 'clearIndex' })}
                className={`${PILL} bg-background text-red-500`}
              >
                {clearingIndex ? 'Clearing…' : 'Clear index'}
              </button>
            </div>
          </div>
          {rebuild.running && (
            <>
              <p role="status" className={`${NOTE} text-foreground/60`}>
                {rebuild.batches === 0
                  ? 'Indexing your chats…'
                  : `Indexed ${plural(recall.chats, 'chat', 'chats')}…`}
              </p>
              <p className={`${NOTE} text-foreground/50`}>
                Keep this screen open: going back stops indexing, and leaving
                the app pauses it.
              </p>
            </>
          )}
          {paused && !rebuild.running && (
            <div className={`${NOTE} flex items-center gap-3`}>
              <p role="status" className="flex-1 text-foreground/60">
                Rebuild paused — {plural(recall.chats, 'chat', 'chats')} indexed
              </p>
              <button
                type="button"
                disabled={clearingIndex || !switches.recallEnabled}
                onClick={() => void startRebuild()}
                className="min-h-11 shrink-0 touch-manipulation rounded-full bg-foreground px-4 text-sm font-semibold text-background active:opacity-50 disabled:opacity-40"
              >
                Continue
              </button>
            </div>
          )}
          <NoteLine note={indexNote} />
        </section>

        <section>
          <h2 id={listLabel} className={SECTION_TITLE}>
            What Ask remembers
          </h2>
          {shown.length === 0 ? (
            <div className={`${GROUP} px-4 py-6 text-center`}>
              <p className="text-base font-semibold">No memories yet</p>
              <p className="pt-1 text-sm text-muted-foreground">
                {switches.memoryEnabled
                  ? 'Useful details from your chats show up here.'
                  : 'Memory is off, so Ask isn’t learning anything new.'}
              </p>
            </div>
          ) : (
            <ul
              aria-labelledby={listLabel}
              className={`${GROUP} divide-y divide-foreground/10 overflow-hidden`}
            >
              {shown.map(memory => (
                <li key={memory.id}>
                  <SwipeRow
                    actions={[
                      {
                        label: 'Delete',
                        tone: 'destructive',
                        onAction: () => setConfirm({ kind: 'delete', memory })
                      }
                    ]}
                    onPress={() => setViewing(memory)}
                  >
                    <div className="flex min-h-14 flex-col justify-center gap-1 px-4 py-3">
                      <span className="line-clamp-3 text-base leading-snug">
                        {memory.content}
                      </span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium tracking-wide uppercase">
                          {categoryLabel(memory.category)}
                        </span>
                        {memory.status === 'candidate' && <LearningBadge />}
                      </span>
                    </div>
                  </SwipeRow>
                </li>
              ))}
            </ul>
          )}
          {shown.length > 0 && (
            <button
              type="button"
              disabled={clearing}
              onClick={() => setConfirm({ kind: 'clearAll' })}
              className={`${GROUP} mt-3 min-h-12 w-full touch-manipulation px-4 text-base font-medium text-red-500 active:opacity-60 disabled:opacity-50`}
            >
              {clearing ? 'Clearing…' : 'Clear all memories'}
            </button>
          )}
          <NoteLine note={listNote} />
        </section>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {/* A pushed screen covers the tab bar, so its content clears the home
          indicator; a status-bar tap scrolls it to the top. */}
      <div
        data-scroll-root
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="safe-bottom">{body}</div>
      </div>

      <ConfirmSheet
        open={confirm?.kind === 'clearIndex'}
        title="Clear the recall index?"
        message="This deletes what Ask indexed from your past chats. The chats themselves stay, and you can rebuild the index at any time."
        confirmLabel="Clear index"
        tone="destructive"
        onConfirm={() => void clearIndex()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmSheet
        open={confirm?.kind === 'clearAll'}
        title="Clear all memories?"
        message="Everything Ask remembers about you is deleted. This can’t be undone."
        confirmLabel="Clear all"
        tone="destructive"
        onConfirm={() => void clearAll()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmSheet
        open={confirm?.kind === 'delete'}
        title="Delete this memory?"
        message={confirm?.kind === 'delete' ? confirm.memory.content : ''}
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={() => {
          if (confirm?.kind === 'delete') void remove(confirm.memory)
        }}
        onClose={() => setConfirm(null)}
      />
      <Sheet
        open={viewing !== null}
        title={viewing ? categoryLabel(viewing.category) : ''}
        onClose={() => setViewing(null)}
      >
        {viewing && (
          <>
            <p className="selectable px-2 pb-3 text-base leading-relaxed">
              {viewing.content}
            </p>
            {viewing.status === 'candidate' && (
              <p className="flex items-center gap-2 px-2 pb-4 text-sm text-muted-foreground">
                <LearningBadge />
                Ask has noticed this but hasn’t confirmed it yet.
              </p>
            )}
            <div className="flex flex-col gap-2 pb-2">
              <button
                type="button"
                onClick={() => {
                  haptic('warning')
                  void remove(viewing)
                  setViewing(null)
                }}
                className={`${SHEET_BUTTON} bg-red-500 text-white`}
              >
                Delete memory
              </button>
              <button
                type="button"
                onClick={() => setViewing(null)}
                className={`${SHEET_BUTTON} bg-muted text-foreground`}
              >
                Done
              </button>
            </div>
          </>
        )}
      </Sheet>
    </div>
  )
}
