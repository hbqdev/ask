// Deleting the account, from Settings: a sheet that says what goes, a field
// where the user types DELETE, and the destructive button. On success the app
// signs out (which clears this account's caches) and the sign-in screen says
// the account was deleted. A 401 signs out too (the session is dead: the
// deletion may have finished with its answer lost, or the session was revoked)
// but claims nothing and clears no device data. On any other failure the user
// stays signed in with the sheet open.

import { useId, useRef, useState, type KeyboardEvent } from 'react'

import { useApi } from '@/core/api/ApiProvider'
import { SIGNED_OUT_MESSAGE, type ApiClient } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'
import { useAuth } from '@/core/auth/AuthProvider'
import { haptic } from '@/core/haptics'
import { Sheet } from '@/core/ui/Sheet'
import { saveCustomInstructions } from '@/features/settings/custom-instructions'

/** What the user types to confirm, exactly (case-sensitive, trimmed). */
const CONFIRM_WORD = 'DELETE'

export const ACCOUNT_DELETED_NOTICE = 'Your account was deleted'
/** After a 401: the app cannot tell a deleted account from a revoked session. */
export const SIGNED_OUT_AFTER_401_NOTICE =
  'You’ve been signed out. If you just deleted your account, it’s gone.'
// Fixed messages: the server's own error text is never shown. The server
// deletes the data before the account, so a failure can leave some of it
// gone: the error promises nothing about what was removed.
export const DELETE_ACCOUNT_ERROR =
  'Couldn’t finish deleting your account. Try again — if it keeps failing, some data may already be removed.'
export const DELETE_ACCOUNT_UNAVAILABLE = 'Not available on this server'

/**
 * Deletes the signed-in user's account and everything in it on the server
 * (DELETE /api/account). Rejects with an ApiError when it didn't.
 */
export async function deleteAccount(client: ApiClient): Promise<void> {
  await client.json('/api/account', {
    method: 'DELETE',
    // A 401 here has its own handling (and notice): see sessionGone.
    signOutOn401: false,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: CONFIRM_WORD })
  })
}

/**
 * Whether a failed deletion means the session is dead: the server answered
 * 401 (its user was deleted, or the session revoked; the app cannot tell
 * which). The client's own 401 for a request it never sent (no token here)
 * says nothing about the session.
 */
export function sessionGone(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 401 &&
    err.message !== SIGNED_OUT_MESSAGE
  )
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
  // Set at once on a tap, so a second tap before the re-render sends
  // nothing more.
  const inFlight = useRef(false)
  const confirmed = typed.trim() === CONFIRM_WORD

  // Only a tap on the destructive button deletes: Return or Done in the
  // field just dismisses the keyboard.
  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    e.currentTarget.blur()
  }

  const confirmDelete = async () => {
    if (!confirmed || inFlight.current) return
    inFlight.current = true
    haptic('warning')
    setDeleting(true)
    setError(null)
    try {
      await deleteAccount(client)
    } catch (err) {
      if (sessionGone(err)) {
        // Signed out, with nothing claimed and no device data cleared: the
        // custom instructions and a waiting share stay.
        await signOut({
          notice: SIGNED_OUT_AFTER_401_NOTICE,
          keepSharedItem: true
        })
        return
      }
      setError(deleteAccountErrorMessage(err))
      setDeleting(false)
      inFlight.current = false
      return
    }
    // The account is gone on the server. Its custom instructions go too (a
    // plain sign-out keeps them as a device preference); a failure to remove
    // them never keeps the app signed in. Signing out clears this account's
    // caches, its session here (even though the server's sign-out now fails)
    // and any share waiting in the inbox, and the sign-in screen that
    // replaces Settings says why.
    await saveCustomInstructions('').catch(() => {})
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
      {/* Not a form: nothing submits implicitly. */}
      <div className="flex flex-col gap-3 pb-2">
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
          onKeyDown={onFieldKey}
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
          className="min-h-12 w-full rounded-xl bg-muted px-4 text-base text-foreground outline-none"
        />
        {error && (
          <p role="alert" className="px-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {/* aria-disabled, not disabled, while deleting: the button keeps
            focus, and the in-flight guard ignores further taps. */}
        <button
          type="button"
          disabled={!confirmed}
          onClick={() => void confirmDelete()}
          aria-disabled={deleting || undefined}
          aria-busy={deleting || undefined}
          className={`${BUTTON} bg-red-600 text-white active:opacity-50 disabled:opacity-25 aria-disabled:opacity-50`}
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
      </div>
    </Sheet>
  )
}
