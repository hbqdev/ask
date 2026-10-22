// Deleting the account, from Settings: a sheet that says what goes, a field
// where the user types DELETE, and the destructive button. On success the app
// signs out (which clears this account's caches) and the sign-in screen says
// the account was deleted; on any failure the user stays signed in with the
// sheet open.

import { useId, useState, type FormEvent } from 'react'

import { useApi } from '@/core/api/ApiProvider'
import type { ApiClient } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'
import { useAuth } from '@/core/auth/AuthProvider'
import { haptic } from '@/core/haptics'
import { Sheet } from '@/core/ui/Sheet'

/** What the user types to confirm, exactly (case-sensitive, trimmed). */
const CONFIRM_WORD = 'DELETE'

export const ACCOUNT_DELETED_NOTICE = 'Your account was deleted'
// Fixed messages: the server's own error text is never shown.
export const DELETE_ACCOUNT_ERROR =
  'Couldn’t delete your account. Nothing was removed — try again.'
export const DELETE_ACCOUNT_UNAVAILABLE = 'Not available on this server'

/**
 * Deletes the signed-in user's account and everything in it on the server
 * (DELETE /api/account). Rejects with an ApiError when it didn't.
 */
export async function deleteAccount(client: ApiClient): Promise<void> {
  await client.json('/api/account', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: CONFIRM_WORD })
  })
}

/** The message for a failed deletion. */
export function deleteAccountErrorMessage(err: unknown): string {
  // 409: the server runs without accounts (anonymous mode).
  return err instanceof ApiError && err.status === 409
    ? DELETE_ACCOUNT_UNAVAILABLE
    : DELETE_ACCOUNT_ERROR
}

export type DeleteAccountSheetProps = {
  open: boolean
  onClose: () => void
}

/** The deletion sheet; each opening starts with an empty field. */
export function DeleteAccountSheet({ open, onClose }: DeleteAccountSheetProps) {
  return open ? <DeleteAccountPanel onClose={onClose} /> : null
}

const BUTTON =
  'min-h-12 w-full touch-manipulation rounded-xl text-base font-medium'

function DeleteAccountPanel({ onClose }: { onClose: () => void }) {
  const { client } = useApi()
  const { signOut } = useAuth()
  const explanationId = useId()
  const fieldId = useId()
  const [typed, setTyped] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmed = typed.trim() === CONFIRM_WORD

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!confirmed || deleting) return
    haptic('warning')
    setDeleting(true)
    setError(null)
    try {
      await deleteAccount(client)
    } catch (err) {
      setError(deleteAccountErrorMessage(err))
      setDeleting(false)
      return
    }
    // The account is gone on the server. Signing out clears this account's
    // caches and its session here (even though the server's sign-out now
    // fails), and the sign-in screen that replaces Settings says why.
    await signOut({ notice: ACCOUNT_DELETED_NOTICE })
  }

  return (
    <Sheet
      open
      // While the deletion runs, nothing closes the sheet.
      onClose={deleting ? () => {} : onClose}
      title="Delete account?"
      describedBy={explanationId}
    >
      <form onSubmit={submit} className="flex flex-col gap-3 pb-2">
        <p
          id={explanationId}
          className="px-2 text-sm leading-relaxed text-muted-foreground"
        >
          Your account and everything in it are permanently deleted: your chats,
          notes, memories and uploads, on all your devices. This can’t be
          undone.
        </p>
        <label htmlFor={fieldId} className="px-2 pt-1 text-sm font-medium">
          Type DELETE to confirm
        </label>
        {/* No autoFocus: the explanation is read (and seen) first. */}
        <input
          id={fieldId}
          value={typed}
          readOnly={deleting}
          onChange={e => setTyped(e.target.value)}
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
          className="min-h-12 w-full rounded-xl bg-muted px-4 text-base text-foreground outline-none"
        />
        {error && (
          <p role="alert" className="px-2 text-sm text-red-500">
            {error}
          </p>
        )}
        {/* aria-disabled, not disabled, while deleting: the button keeps
            focus, and the submit guard ignores further taps. */}
        <button
          type="submit"
          disabled={!confirmed}
          aria-disabled={deleting || undefined}
          aria-busy={deleting || undefined}
          className={`${BUTTON} bg-red-500 text-white active:opacity-50 disabled:opacity-25 aria-disabled:opacity-50`}
        >
          {deleting ? 'Deleting…' : 'Delete my account'}
        </button>
        <button
          type="button"
          disabled={deleting}
          onClick={onClose}
          className={`${BUTTON} bg-muted text-foreground active:opacity-50 disabled:opacity-50`}
        >
          Cancel
        </button>
      </form>
    </Sheet>
  )
}
