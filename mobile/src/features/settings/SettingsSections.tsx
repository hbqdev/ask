// The Settings tab's sections, top to bottom: Account, Answers,
// Personalization, Appearance, Data and About.

import { App } from '@capacitor/app'
import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { useTabActive } from '@/app/Tabs'
import { useApi } from '@/core/api/ApiProvider'
import { useAuth } from '@/core/auth/AuthProvider'
import { emitChatsChanged } from '@/core/chats-events'
import type { ThemePref } from '@/core/theme'
import { useTheme } from '@/core/ThemeProvider'
import { ConfirmSheet } from '@/core/ui/ConfirmSheet'
import { ModelPicker } from '@/features/compose/ModelPicker'
import {
  SearchModeField,
  SourcesField
} from '@/features/compose/SearchOptionFields'
import { useSharedSearchSettings } from '@/features/compose/SearchSettingsProvider'
import { clearAllChats } from '@/features/library/library-api'
import { clearLibraryCache } from '@/features/library/library-cache'
import {
  CUSTOM_INSTRUCTIONS_MAX,
  loadCustomInstructions,
  normalizeCustomInstructions,
  saveCustomInstructions
} from '@/features/settings/custom-instructions'

export const INSTRUCTIONS_SAVE_ERROR = 'Couldn’t save. Try again.'
export const DELETE_ALL_ERROR = 'Couldn’t delete your chats. Try again.'

const SECTION_TITLE =
  'px-4 pb-2 text-xs font-medium uppercase tracking-wide text-foreground/50'
const GROUP = 'rounded-2xl bg-foreground/5'
const ROW_BUTTON = `${GROUP} min-h-12 w-full touch-manipulation px-4 text-base font-medium active:opacity-60`
const NOTE = 'px-4 pt-2 text-sm'

// --- Account ----------------------------------------------------------------

/** The signed-in email and Sign out, after a confirmation. */
export function AccountSection() {
  const { session, signOut } = useAuth()
  const email = session?.user.email
  const [confirming, setConfirming] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  const confirmSignOut = () => {
    setSigningOut(true)
    void signOut().finally(() => setSigningOut(false))
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className={SECTION_TITLE}>Account</h2>
      {email && (
        <div className={`${GROUP} px-4 py-3`}>
          <p className="text-sm text-foreground/60">Signed in as</p>
          <p className="truncate text-base">{email}</p>
        </div>
      )}
      <button
        type="button"
        disabled={signingOut}
        onClick={() => setConfirming(true)}
        className={`${ROW_BUTTON} text-red-500 disabled:opacity-50`}
      >
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
      <ConfirmSheet
        open={confirming}
        title="Sign out?"
        confirmLabel="Sign out"
        tone="destructive"
        onConfirm={confirmSignOut}
        onClose={() => setConfirming(false)}
      />
    </section>
  )
}

// --- Answers ----------------------------------------------------------------

/**
 * How questions are answered: the search mode, the sources and the model.
 * The same settings the composer's options change.
 */
export function AnswersSection() {
  const [settings, setSettings] = useSharedSearchSettings()
  return (
    <section className="flex flex-col gap-5">
      <h2 className={`${SECTION_TITLE} pb-0`}>Answers</h2>
      <SearchModeField settings={settings} onSettings={setSettings} />
      <SourcesField settings={settings} onSettings={setSettings} />
      <ModelPicker />
    </section>
  )
}

// --- Personalization --------------------------------------------------------

type SaveStatus = 'idle' | 'saved' | 'failed'

/**
 * The custom instructions sent with every question. Saved when the field
 * loses focus, when the Settings tab is left, when the app goes to the
 * background, and when the screen goes away.
 */
export function PersonalizationSection() {
  const fieldId = useId()
  const active = useTabActive()
  const [text, setText] = useState('')
  const [status, setStatus] = useState<SaveStatus>('idle')
  // The field's text for the save triggers outside React's render.
  const textRef = useRef('')
  // What storage holds (normalized): a save of the same text is skipped.
  const stored = useRef('')
  // Set on the first edit, so a slow load cannot replace what was typed.
  const edited = useRef(false)

  useEffect(() => {
    void loadCustomInstructions().then(value => {
      if (edited.current) return
      stored.current = value
      textRef.current = value
      setText(value)
    })
  }, [])

  const save = useCallback(() => {
    const next = normalizeCustomInstructions(textRef.current)
    const previous = stored.current
    if (next === previous) return
    stored.current = next
    saveCustomInstructions(next).then(
      () => setStatus('saved'),
      () => {
        // So the next trigger tries again.
        if (stored.current === next) stored.current = previous
        setStatus('failed')
      }
    )
  }, [])

  // Leaving the tab (kept mounted, only hidden) does not always blur.
  useEffect(() => {
    if (!active) save()
  }, [active, save])

  useEffect(() => {
    const handle = App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) save()
    })
    return () => {
      save()
      void handle.then(h => h.remove())
    }
  }, [save])

  return (
    <section>
      <h2 className={SECTION_TITLE}>Personalization</h2>
      <div className={`${GROUP} px-4 py-3`}>
        <label htmlFor={fieldId} className="text-sm text-foreground/60">
          Custom instructions
        </label>
        <textarea
          id={fieldId}
          value={text}
          maxLength={CUSTOM_INSTRUCTIONS_MAX}
          rows={5}
          placeholder="e.g. “Answer concisely” or “Use British English”"
          onChange={e => {
            edited.current = true
            textRef.current = e.target.value
            setText(e.target.value)
            setStatus('idle')
          }}
          onBlur={save}
          className="mt-1 block w-full resize-none bg-transparent text-base placeholder:text-foreground/40 focus:outline-none"
        />
      </div>
      <div className={`${NOTE} flex gap-3 text-foreground/50`}>
        <p className="flex-1">Sent with every question.</p>
        {status === 'saved' && (
          <p role="status" className="text-foreground/60">
            Saved
          </p>
        )}
        <p className="tabular-nums">
          {text.length}/{CUSTOM_INSTRUCTIONS_MAX}
        </p>
      </div>
      {status === 'failed' && (
        <p role="alert" className={`${NOTE} text-red-500`}>
          {INSTRUCTIONS_SAVE_ERROR}
        </p>
      )}
    </section>
  )
}

// --- Appearance -------------------------------------------------------------

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

/** The theme: system, light or dark. */
export function AppearanceSection() {
  const { pref, setPref } = useTheme()
  const themeLabel = useId()
  return (
    <section>
      <h2 id={themeLabel} className={SECTION_TITLE}>
        Appearance
      </h2>
      <div
        role="radiogroup"
        aria-labelledby={themeLabel}
        className={`${GROUP} flex gap-1 p-1`}
      >
        {THEME_OPTIONS.map(option => {
          const checked = option.value === pref
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => setPref(option.value)}
              className={`min-h-11 flex-1 touch-manipulation rounded-xl text-sm font-medium ${
                checked
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-foreground/60 active:opacity-50'
              }`}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </section>
  )
}

// --- Data -------------------------------------------------------------------

type DeleteStatus = 'idle' | 'deleting' | 'done' | 'failed'

/** Delete all chats, after a confirmation. */
export function DataSection() {
  const { client } = useApi()
  const [confirming, setConfirming] = useState(false)
  const [status, setStatus] = useState<DeleteStatus>('idle')

  const deleteAll = async () => {
    setStatus('deleting')
    try {
      await clearAllChats(client)
    } catch {
      setStatus('failed')
      return
    }
    // Before telling the Library, whose reload then caches the empty list.
    await clearLibraryCache().catch(() => {})
    emitChatsChanged('cleared')
    setStatus('done')
  }

  return (
    <section>
      <h2 className={SECTION_TITLE}>Data</h2>
      <button
        type="button"
        disabled={status === 'deleting'}
        onClick={() => setConfirming(true)}
        className={`${ROW_BUTTON} text-red-500 disabled:opacity-50`}
      >
        {status === 'deleting' ? 'Deleting…' : 'Delete all chats'}
      </button>
      {status === 'done' && (
        <p role="status" className={`${NOTE} text-foreground/50`}>
          All chats deleted.
        </p>
      )}
      {status === 'failed' && (
        <p role="alert" className={`${NOTE} text-red-500`}>
          {DELETE_ALL_ERROR}
        </p>
      )}
      <ConfirmSheet
        open={confirming}
        title="Delete all chats?"
        message="Every chat in your history is deleted, on all your devices. This can’t be undone."
        confirmLabel="Delete all"
        tone="destructive"
        onConfirm={() => void deleteAll()}
        onClose={() => setConfirming(false)}
      />
    </section>
  )
}

// --- About ------------------------------------------------------------------

/**
 * The app version and the Ask server it talks to. The version is the
 * installed app's (its bundle version); where that is not available (the
 * web), the version this code was built with.
 */
export function AboutSection() {
  const { baseUrl } = useApi()
  const [version, setVersion] = useState(__APP_VERSION__)
  useEffect(() => {
    let current = true
    // Also when getInfo is missing altogether (a test or web shim).
    Promise.resolve()
      .then(() => App.getInfo())
      .then(
        info => {
          if (current) setVersion(info.version)
        },
        () => {}
      )
    return () => {
      current = false
    }
  }, [])
  const rows = [
    { label: 'Version', value: version },
    { label: 'Server', value: new URL(baseUrl).host }
  ]
  return (
    <section>
      <h2 className={SECTION_TITLE}>About</h2>
      <dl className={`${GROUP} divide-y divide-foreground/10`}>
        {rows.map(row => (
          <div
            key={row.label}
            className="flex min-h-11 items-center gap-3 px-4"
          >
            <dt className="flex-1 text-base">{row.label}</dt>
            <dd className="truncate text-base text-foreground/60">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
