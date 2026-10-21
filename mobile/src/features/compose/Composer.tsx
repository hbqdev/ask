// The question box at the bottom of the home screen and of every thread: a
// text field that grows to six lines, Send (Stop while a turn runs), and a chip
// with the search mode that opens the options sheet. The keyboard shrinks the
// web view natively (capacitor.config.ts), so the box simply sits at the
// bottom; `.composer` (styles.css) clears the home indicator.

import {
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent
} from 'react'

import {
  OptionsSheet,
  SEARCH_MODE_LABELS
} from '@/features/compose/OptionsSheet'
import type { SearchSettings } from '@/features/thread/chat-body'

const LINE_HEIGHT_PX = 24
const MAX_LINES = 6
/** The field's vertical padding (py-2), inside its height. */
const PADDING_Y_PX = 16
/** The tallest the field grows; past it the text scrolls. */
export const COMPOSER_MAX_HEIGHT_PX = MAX_LINES * LINE_HEIGHT_PX + PADDING_Y_PX

/** The keyCode Safari gives the Enter that commits an IME composition. */
const IME_KEY_CODE = 229

export type ComposerProps = {
  /** The hint in the empty field, which also names it. */
  placeholder: string
  /** A turn is running: the button is Stop instead of Send. */
  busy: boolean
  onSend: (text: string) => void
  /** Stops the running turn; needed wherever `busy` can be true. */
  onStop?: () => void
  settings: SearchSettings
  onSettings: (settings: SearchSettings) => void
  autoFocus?: boolean
  /** Nothing can be sent yet (the chat is loading); typing still works. */
  disabled?: boolean
}

function ArrowUp() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
    </svg>
  )
}

function StopSquare() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4">
      <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
    </svg>
  )
}

export function Composer({
  placeholder,
  busy,
  onSend,
  onStop,
  settings,
  onSettings,
  autoFocus,
  disabled = false
}: ComposerProps) {
  const [text, setText] = useState('')
  const [optionsOpen, setOptionsOpen] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)

  // Fit the field to its text, up to six lines.
  useLayoutEffect(() => {
    const el = field.current!
    el.style.height = 'auto'
    const height = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)
    el.style.height = `${height}px`
    el.style.overflowY =
      el.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? 'auto' : 'hidden'
  }, [text])

  const canSend = !busy && !disabled && text.trim().length > 0

  const send = () => {
    if (!canSend) return
    onSend(text.trim())
    setText('')
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    send()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    // The Enter that picks an IME candidate is not a send.
    if (e.nativeEvent.isComposing || e.keyCode === IME_KEY_CODE) return
    e.preventDefault()
    send()
  }

  // A mode with no label (never stored: settings are validated) shows as is.
  const modeLabel =
    (SEARCH_MODE_LABELS[settings.searchMode] as string | undefined) ??
    settings.searchMode

  return (
    <form className="composer bg-background px-3 pt-2" onSubmit={onSubmit}>
      <div className="rounded-3xl bg-foreground/5 px-3 pt-1 pb-2">
        <textarea
          ref={field}
          rows={1}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          autoFocus={autoFocus}
          enterKeyHint="send"
          className="block w-full resize-none bg-transparent py-2 text-base leading-6 outline-none placeholder:text-foreground/40"
        />
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            aria-label={`Search mode: ${modeLabel}`}
            aria-haspopup="dialog"
            onClick={() => setOptionsOpen(true)}
            className="flex min-h-9 touch-manipulation items-center gap-1 rounded-full bg-foreground/8 px-3 text-sm font-medium text-foreground/70 active:opacity-50"
          >
            {modeLabel}
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {busy ? (
            <button
              type="button"
              aria-label="Stop"
              onClick={onStop}
              className="flex size-9 touch-manipulation items-center justify-center rounded-full bg-foreground text-background active:opacity-50"
            >
              <StopSquare />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              disabled={!canSend}
              className="flex size-9 touch-manipulation items-center justify-center rounded-full bg-foreground text-background active:opacity-50 disabled:opacity-25"
            >
              <ArrowUp />
            </button>
          )}
        </div>
      </div>
      <OptionsSheet
        open={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        settings={settings}
        onSettings={onSettings}
      />
    </form>
  )
}
