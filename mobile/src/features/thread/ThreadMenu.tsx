// The thread header's "…" menu: share the open chat as a public link (and,
// once shared, copy the link or stop sharing), rename it or delete it. A
// rename or delete tells the chat list (chats-changed), so the Library shows
// it. Only Share link makes the chat public: Copy link copies the link it is
// given and never publishes a chat made private elsewhere again. The link is
// made with the menu open, and a failure to make or copy it is said there;
// any other failure is said in a line under the header that the user can
// dismiss. A cancelled share sheet is no failure.

import { Clipboard } from '@capacitor/clipboard'
import { Share } from '@capacitor/share'
import { useEffect, useRef, useState } from 'react'

import { useApi } from '@/core/api/ApiProvider'
import { ApiError } from '@/core/api/errors'
import { emitChatsChanged } from '@/core/chats-events'
import { haptic } from '@/core/haptics'
import { ConfirmSheet } from '@/core/ui/ConfirmSheet'
import { Sheet } from '@/core/ui/Sheet'
import { TextPromptSheet } from '@/core/ui/TextPromptSheet'
import {
  CHAT_TITLE_MAX_LENGTH,
  deleteChat,
  renameChat
} from '@/features/library/library-api'
import {
  COPIED_MS,
  isShareCancelled,
  reasonOf,
  SHARE_LINK_ERROR
} from '@/features/thread/share-api'
import { useMakeLink } from '@/features/thread/useMakeLink'

export type ThreadMenuProps = {
  chatId: string
  /** The title the header shows, which the rename prompt starts from. */
  title: string
  /** The chat was renamed; `title` is the one the server saved. */
  onRenamed: (title: string) => void
  /** The chat is gone: leave its screen. */
  onDeleted: () => void
  /** The chat is public: offer Copy link and Stop sharing. */
  shared: boolean
  /** The chat's public link, which Copy link copies as it is. */
  link: string
  /** Makes the chat public and resolves with its link. */
  createLink: () => Promise<string>
  /** Makes the chat private again. */
  stopSharing: () => Promise<void>
}

type Open = 'menu' | 'rename' | 'delete' | 'unshare' | null

const MENU_ITEM =
  'min-h-12 touch-manipulation rounded-xl px-4 text-left text-base active:bg-muted'

export function ThreadMenu({
  chatId,
  title,
  onRenamed,
  onDeleted,
  shared,
  link,
  createLink,
  stopSharing
}: ThreadMenuProps) {
  const { client } = useApi()
  const [open, setOpen] = useState<Open>(null)
  const [failure, setFailure] = useState<string>()
  // A delete on its way: the menu can't be opened again until it ends.
  const [deleting, setDeleting] = useState(false)
  // Share link's link, made with the menu open; a failed copy, said in the
  // menu; and "Copied" after a copy.
  const newLink = useMakeLink()
  const [copyFailure, setCopyFailure] = useState<string>()
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const close = () => {
    newLink.cancel()
    setOpen(null)
  }

  const openMenu = () => {
    setFailure(undefined)
    newLink.cancel()
    setCopyFailure(undefined)
    clearTimeout(copiedTimer.current)
    setCopied(false)
    setOpen('menu')
  }

  // Whether this screen is still up: a delete that lands after the user left
  // must not pop whatever screen is now on top.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const rename = async (next: string) => {
    try {
      const saved = await renameChat(client, chatId, next)
      emitChatsChanged('renamed', chatId, { title: saved })
      onRenamed(saved)
    } catch (error) {
      setFailure(`Couldn’t rename the chat. ${reasonOf(error)}`)
    }
  }

  const shareLink = async () => {
    setCopyFailure(undefined)
    const url = await newLink.run(createLink)
    if (!url) return
    close()
    try {
      await Share.share({ title, url })
    } catch (error) {
      if (!isShareCancelled(error)) setFailure(SHARE_LINK_ERROR)
    }
  }

  // Never makes a link: that would publish the chat again if it was made
  // private elsewhere since it loaded. A link that no longer opens is better.
  const copyLink = async () => {
    newLink.cancel()
    setCopyFailure(undefined)
    try {
      await Clipboard.write({ string: link })
    } catch {
      setCopyFailure('Couldn’t copy the link.')
      return
    }
    haptic('success')
    setCopied(true)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }

  const unshare = async () => {
    try {
      await stopSharing()
    } catch (error) {
      setFailure(`Couldn’t stop sharing. ${reasonOf(error)}`)
    }
  }

  const remove = async () => {
    setDeleting(true)
    try {
      await deleteChat(client, chatId)
    } catch (error) {
      // Already gone on the server: that is what the user wanted.
      if (!(error instanceof ApiError && error.status === 404)) {
        setDeleting(false)
        setFailure(`Couldn’t delete the chat. ${reasonOf(error)}`)
        return
      }
    }
    emitChatsChanged('deleted', chatId)
    if (mounted.current) onDeleted()
  }

  return (
    <>
      <button
        type="button"
        aria-label="Chat options"
        aria-busy={deleting || undefined}
        disabled={deleting}
        onClick={openMenu}
        className="flex size-11 shrink-0 touch-manipulation items-center justify-center rounded-full text-foreground/70 active:opacity-50"
      >
        {deleting ? (
          <span
            aria-hidden="true"
            className="size-5 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground/70"
          />
        ) : (
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="size-6"
            fill="currentColor"
          >
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        )}
      </button>
      {deleting && (
        <span role="status" className="sr-only">
          Deleting chat…
        </span>
      )}

      {failure && (
        <div
          role="alert"
          className="absolute inset-x-3 top-full z-10 mt-2 overflow-hidden rounded-2xl bg-background shadow-lg"
        >
          <div className="flex items-center gap-3 bg-red-500/10 px-4 py-1 text-sm text-destructive">
            <p className="min-w-0 flex-1">{failure}</p>
            <button
              type="button"
              onClick={() => setFailure(undefined)}
              className="min-h-11 shrink-0 touch-manipulation rounded-full px-3 font-semibold active:opacity-50"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <Sheet open={open === 'menu'} onClose={close} title="Chat options">
        <div className="flex flex-col gap-1 pb-2">
          <button
            type="button"
            aria-busy={newLink.making || undefined}
            disabled={newLink.making}
            onClick={() => void shareLink()}
            className={`${MENU_ITEM} text-foreground disabled:opacity-50`}
          >
            {newLink.making ? 'Creating link…' : 'Share link'}
          </button>
          {shared && (
            <>
              <button
                type="button"
                disabled={newLink.making}
                onClick={() => void copyLink()}
                className={`${MENU_ITEM} text-foreground disabled:opacity-50`}
              >
                {copied ? 'Copied' : 'Copy link'}
              </button>
              <button
                type="button"
                disabled={newLink.making}
                onClick={() => setOpen('unshare')}
                className={`${MENU_ITEM} text-foreground disabled:opacity-50`}
              >
                Stop sharing
              </button>
            </>
          )}
          <button
            type="button"
            disabled={newLink.making}
            onClick={() => setOpen('rename')}
            className={`${MENU_ITEM} text-foreground disabled:opacity-50`}
          >
            Rename
          </button>
          <button
            type="button"
            disabled={newLink.making}
            onClick={() => setOpen('delete')}
            className={`${MENU_ITEM} text-destructive disabled:opacity-50`}
          >
            Delete chat
          </button>
          {(newLink.error ?? copyFailure) && (
            <p role="alert" className="px-4 pt-1 text-sm text-destructive">
              {newLink.error ?? copyFailure}
            </p>
          )}
        </div>
      </Sheet>
      <TextPromptSheet
        open={open === 'rename'}
        title="Rename chat"
        initialValue={title}
        maxLength={CHAT_TITLE_MAX_LENGTH}
        confirmLabel="Rename"
        onSubmit={next => void rename(next)}
        onClose={close}
      />
      <ConfirmSheet
        open={open === 'unshare'}
        title="Stop sharing this chat?"
        message="The link will stop working for anyone who has it."
        confirmLabel="Stop sharing"
        tone="destructive"
        onConfirm={() => void unshare()}
        onClose={close}
      />
      <ConfirmSheet
        open={open === 'delete'}
        title="Delete this chat?"
        message="This can’t be undone."
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={() => void remove()}
        onClose={close}
      />
    </>
  )
}
