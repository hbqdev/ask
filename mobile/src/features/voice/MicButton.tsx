// Dictation's controls in the composer. MicButton sits where Send does while
// the box is empty: tap to record; while recording it is a stop button inside
// a ring that swells with the voice; while transcribing it rests. DictationBar
// takes the text field's place meanwhile: a cancel, a pulsing dot and the
// time recorded, then a spinner while the words come back.

import type { Dictation } from '@/features/voice/useDictation'

/** Whole seconds as mm:ss. */
export function formatElapsed(seconds: number): string {
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/**
 * The ring's size for a level: speech is a small RMS (about 0.02 to 0.25),
 * so it is amplified, and capped at half again the button's size.
 */
export function levelScale(level: number): number {
  return Math.round((1 + Math.min(level * 4, 1) * 0.5) * 100) / 100
}

function MicIcon() {
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
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
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

function Cross() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

function Spinner() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5 animate-spin"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
    >
      <path d="M12 3a9 9 0 0 1 9 9" />
    </svg>
  )
}

const ROUND_BUTTON =
  'flex size-9 shrink-0 touch-manipulation items-center justify-center rounded-full'

export function MicButton({ dictation }: { dictation: Dictation }) {
  const { state, level } = dictation

  if (state === 'recording') {
    return (
      <span className="relative flex size-9 shrink-0">
        <span
          aria-hidden="true"
          data-testid="level-ring"
          className="absolute inset-0 rounded-full bg-red-500/30 transition-transform duration-100 ease-out"
          style={{ transform: `scale(${levelScale(level)})` }}
        />
        <button
          type="button"
          aria-label="Stop recording"
          onClick={dictation.stop}
          className={`relative bg-red-500 text-white active:opacity-50 ${ROUND_BUTTON}`}
        >
          <StopSquare />
        </button>
      </span>
    )
  }

  if (state === 'transcribing') {
    return (
      <button
        type="button"
        aria-label="Transcribing"
        disabled
        className={`bg-foreground text-background opacity-25 ${ROUND_BUTTON}`}
      >
        <MicIcon />
      </button>
    )
  }

  return (
    <button
      type="button"
      aria-label="Dictate"
      onClick={dictation.start}
      className={`bg-foreground text-background active:opacity-50 ${ROUND_BUTTON}`}
    >
      <MicIcon />
    </button>
  )
}

export function DictationBar({ dictation }: { dictation: Dictation }) {
  if (dictation.state === 'recording') {
    return (
      <div className="flex min-h-10 items-center gap-2">
        <button
          type="button"
          aria-label="Cancel recording"
          onClick={dictation.cancel}
          className="-ml-1 flex size-9 shrink-0 touch-manipulation items-center justify-center rounded-full text-foreground/70 active:bg-foreground/10"
        >
          <Cross />
        </button>
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full bg-red-500 motion-safe:animate-pulse"
        />
        <span role="timer" className="text-base tabular-nums">
          {formatElapsed(dictation.seconds)}
        </span>
      </div>
    )
  }

  if (dictation.state === 'transcribing') {
    return (
      <div
        role="status"
        className="flex min-h-10 items-center gap-2 text-base text-foreground/60"
      >
        <Spinner />
        Transcribing…
      </div>
    )
  }

  return null
}
