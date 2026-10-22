// The question box at the bottom of the home screen and of every thread: a
// text field that grows to six lines, Send (Stop while a turn runs), a
// paperclip that attaches photos and files (shown as chips above the field),
// and a chip with the search mode that opens the options sheet. While the box
// is empty a mic takes Send's place: dictation records, transcribes and sends
// the words (features/voice), the field showing the recording meanwhile. The keyboard
// ends the web view at its top (MainViewController.swift), so the box simply sits
// at the bottom; `.composer` (styles.css) clears the home indicator.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject
} from 'react'

import { useTabActive } from '@/app/Tabs'
import { haptic } from '@/core/haptics'
import { useScreenActive } from '@/core/nav/stack'
import { Sheet } from '@/core/ui/Sheet'
import { AttachmentChips } from '@/features/compose/AttachmentChips'
import { OptionsSheet } from '@/features/compose/OptionsSheet'
import { SEARCH_MODE_LABELS } from '@/features/compose/SearchOptionFields'
import {
  OVER_LIMIT_MESSAGE,
  useAttachments
} from '@/features/compose/useAttachments'
import type { FilePart, SearchSettings } from '@/features/thread/chat-body'
import { DictationBar, MicButton } from '@/features/voice/MicButton'
import { useDictation } from '@/features/voice/useDictation'
import { ACCEPT_ATTRIBUTE } from '@/lib/config/upload-allowlist'

const MAX_LINES = 6
/** The field's vertical padding (py-2, fixed px), inside its height. */
const PADDING_Y_PX = 16
/** A line where nothing is laid out (text-base at the default text size). */
const FALLBACK_LINE_HEIGHT_PX = 24

/**
 * The field's line height in px, as laid out: it follows the iOS text size
 * (src/core/text-size.ts). `normal` counts as 1.5 × the font size.
 */
function lineHeightPx(style: CSSStyleDeclaration): number {
  const line = parseFloat(style.lineHeight)
  if (line > 0) return line
  const font = parseFloat(style.fontSize)
  return font > 0 ? font * 1.5 : FALLBACK_LINE_HEIGHT_PX
}

/** The tallest the field grows (six lines); past it the text scrolls. */
function maxFieldHeight(el: HTMLElement): number {
  return MAX_LINES * lineHeightPx(getComputedStyle(el)) + PADDING_Y_PX
}

/** The keyCode Safari gives the Enter that commits an IME composition. */
const IME_KEY_CODE = 229

export type ComposerProps = {
  /** The hint in the empty field, which also names it. */
  placeholder: string
  /** A turn is running: the button is Stop instead of Send. */
  busy: boolean
  /** The trimmed text (empty when only files go) and the uploaded files. */
  onSend: (text: string, files: FilePart[]) => void
  /** The chat the attachments are uploaded under (x-chat-id). */
  chatId?: string
  /** Stops the running turn; needed wherever `busy` can be true. */
  onStop?: () => void
  settings: SearchSettings
  onSettings: (settings: SearchSettings) => void
  autoFocus?: boolean
  /** Nothing can be sent yet (the chat is loading); typing still works. */
  disabled?: boolean
  /**
   * Text to put in the box, focused, for the user to send (an ask:// link,
   * or an item shared to Ask). Each new object fills the box again, even with
   * the same text. With `append`, text already in the box is kept and the
   * draft goes on a new line under it.
   */
  draft?: { text: string; append?: boolean }
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

function Paperclip() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m21 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" />
    </svg>
  )
}

const SHEET_OPTION =
  'min-h-12 w-full touch-manipulation rounded-xl bg-muted text-base font-medium text-foreground active:opacity-50'

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
  chatId,
  onStop,
  settings,
  onSettings,
  autoFocus,
  disabled = false,
  draft
}: ComposerProps) {
  const [text, setText] = useState('')
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const attachments = useAttachments(chatId)
  const photoInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // Nothing goes while a file is still uploading or has failed.
  const sendable = !busy && !disabled && attachments.ready
  const canSend =
    sendable && (text.trim().length > 0 || attachments.items.length > 0)

  /** Sends; `tapped` is false for dictation, whose stop already tapped. */
  const submit = (body: string, tapped = true) => {
    if (tapped) haptic('light')
    onSend(body, attachments.parts())
    setText('')
    attachments.clear()
  }

  const send = () => {
    if (canSend) submit(text.trim())
  }

  // The words go as soon as they are back, as the web's push-to-talk does,
  // with any files attached; when nothing can go yet they wait in the box.
  // Text typed while the mic opened is never lost: the words go after it and
  // the whole waits in the box, for the user to send.
  // Dictation ends when this screen is left: another tab, or a screen pushed
  // over it.
  const tabShown = useTabActive()
  const screenShown = useScreenActive()
  const dictation = useDictation({
    onText: words => {
      const typed = text.trim()
      if (typed) setText(`${typed} ${words}`)
      else if (sendable) submit(words, false)
      else setText(words)
    },
    active: tabShown && screenShown
  })
  const dictating =
    dictation.state === 'recording' || dictation.state === 'transcribing'
  // From the mic opening until the words are back ('error' is at rest).
  const dictationUnderWay = dictating || dictation.state === 'starting'
  const showMic =
    dictationUnderWay ||
    (!busy && text.trim().length === 0 && attachments.items.length === 0)

  // A draft (an ask:// link, a shared item) ends any dictation, so it is
  // never merged into words that send themselves; it waits in the box,
  // focused, once the box is back from under the recording.
  const { cancel: cancelDictation } = dictation
  const focusWhenShown = useRef(false)
  useEffect(() => {
    if (!draft) return
    cancelDictation()
    setText(typed =>
      draft.append && typed.trim()
        ? `${typed.trimEnd()}\n${draft.text}`
        : draft.text
    )
    focusWhenShown.current = true
  }, [draft, cancelDictation])
  useEffect(() => {
    if (!focusWhenShown.current || dictating) return
    focusWhenShown.current = false
    field.current!.focus()
  })

  // Fit the field to its text, up to six lines (again once it is back from
  // under the recording).
  useLayoutEffect(() => {
    const el = field.current!
    el.style.height = 'auto'
    const max = maxFieldHeight(el)
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [text, dictating])

  // The picker opens within the tap, as iOS requires.
  const pick = (input: RefObject<HTMLInputElement | null>) => {
    setAttachOpen(false)
    input.current!.click()
  }

  const onPicked = (e: ChangeEvent<HTMLInputElement>) => {
    attachments.add(e.target.files!)
    // Cleared, so picking the same file again still fires a change.
    e.target.value = ''
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
        <AttachmentChips
          items={attachments.items}
          onRemove={attachments.remove}
          onRetry={attachments.retry}
        />
        {attachments.overLimit && (
          <p role="status" className="pt-1 text-xs text-foreground/60">
            {OVER_LIMIT_MESSAGE}
          </p>
        )}
        <DictationBar dictation={dictation} />
        <textarea
          ref={field}
          hidden={dictating}
          rows={1}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          autoFocus={autoFocus}
          enterKeyHint="send"
          className="block w-full resize-none bg-transparent py-2 text-base outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              aria-label="Attach"
              aria-haspopup="dialog"
              // No picker opens over a recording.
              disabled={dictationUnderWay}
              onClick={() => setAttachOpen(true)}
              className="flex size-9 shrink-0 touch-manipulation items-center justify-center rounded-full text-foreground/70 active:bg-foreground/10 disabled:opacity-25"
            >
              <Paperclip />
            </button>
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
          </div>
          {showMic ? (
            <MicButton dictation={dictation} />
          ) : busy ? (
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
      {dictation.state === 'error' && (
        <p role="alert" className="px-3 pt-1 text-xs text-foreground/60">
          {dictation.error}
        </p>
      )}
      <input
        ref={photoInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="pick-photos"
        onChange={onPicked}
      />
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        data-testid="take-photo"
        onChange={onPicked}
      />
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        multiple
        hidden
        data-testid="pick-files"
        onChange={onPicked}
      />
      <Sheet
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        title="Attach"
      >
        <div className="flex flex-col gap-2 pb-2">
          <button
            type="button"
            onClick={() => pick(photoInput)}
            className={SHEET_OPTION}
          >
            Photo Library
          </button>
          <button
            type="button"
            onClick={() => pick(cameraInput)}
            className={SHEET_OPTION}
          >
            Take Photo
          </button>
          <button
            type="button"
            onClick={() => pick(fileInput)}
            className={SHEET_OPTION}
          >
            Choose File
          </button>
        </div>
      </Sheet>
      <OptionsSheet
        open={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        settings={settings}
        onSettings={onSettings}
      />
    </form>
  )
}
