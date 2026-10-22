// A confirmation in a bottom sheet: a title, an optional message, the
// confirming button and Cancel. Confirming also closes the sheet; a
// destructive confirm warns with a haptic.

import { haptic } from '@/core/haptics'
import { Sheet } from '@/core/ui/Sheet'

export type ConfirmSheetProps = {
  open: boolean
  title: string
  message?: string
  confirmLabel: string
  /** 'destructive' paints the confirming button red. */
  tone?: 'destructive'
  onConfirm: () => void
  onClose: () => void
}

const BUTTON =
  'min-h-12 w-full touch-manipulation rounded-xl text-base font-medium active:opacity-50'

export function ConfirmSheet({
  open,
  title,
  message,
  confirmLabel,
  tone,
  onConfirm,
  onClose
}: ConfirmSheetProps) {
  const confirmColour =
    tone === 'destructive'
      ? 'bg-red-600 text-white'
      : 'bg-foreground text-background'
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {message && (
        <p className="px-2 pb-4 text-sm leading-relaxed text-muted-foreground">
          {message}
        </p>
      )}
      <div className="flex flex-col gap-2 pb-2">
        <button
          type="button"
          onClick={() => {
            if (tone === 'destructive') haptic('warning')
            onConfirm()
            onClose()
          }}
          className={`${BUTTON} ${confirmColour}`}
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
      </div>
    </Sheet>
  )
}
