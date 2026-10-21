// A one-line text prompt in a bottom sheet (renaming a chat). The value is
// trimmed on submit, a blank value can't be submitted, and Enter submits.
// Submitting also closes the sheet.

import { useState, type FormEvent } from 'react'

import { Sheet } from '@/core/ui/Sheet'

export type TextPromptSheetProps = {
  open: boolean
  title: string
  initialValue: string
  maxLength: number
  confirmLabel: string
  onSubmit: (value: string) => void
  onClose: () => void
}

const BUTTON =
  'min-h-12 w-full touch-manipulation rounded-xl text-base font-medium active:opacity-50'

export function TextPromptSheet({
  open,
  title,
  onClose,
  ...form
}: TextPromptSheetProps) {
  // The form mounts with the sheet, so each opening starts from initialValue.
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <PromptForm title={title} onClose={onClose} {...form} />
    </Sheet>
  )
}

function PromptForm({
  title,
  initialValue,
  maxLength,
  confirmLabel,
  onSubmit,
  onClose
}: Omit<TextPromptSheetProps, 'open'>) {
  const [value, setValue] = useState(() => initialValue.slice(0, maxLength))
  const trimmed = value.trim()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!trimmed) return
    onSubmit(trimmed)
    onClose()
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 pb-2">
      <input
        aria-label={title}
        autoFocus
        enterKeyHint="done"
        maxLength={maxLength}
        value={value}
        onChange={e => setValue(e.target.value.slice(0, maxLength))}
        className="min-h-12 w-full rounded-xl bg-muted px-4 text-base text-foreground outline-none"
      />
      <button
        type="submit"
        disabled={!trimmed}
        className={`${BUTTON} bg-foreground text-background disabled:opacity-25`}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={onClose}
        className={`${BUTTON} bg-muted text-foreground`}
      >
        Cancel
      </button>
    </form>
  )
}
