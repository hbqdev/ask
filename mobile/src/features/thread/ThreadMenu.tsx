// The thread header's "…" menu: rename or delete the open chat. Each change
// tells the chat list (chats-changed), so the Library shows it; a failure is
// said in a line under the header that the user can dismiss.

import { useEffect, useRef, useState } from 'react'

import { useApi } from '@/core/api/ApiProvider'
import { ApiError } from '@/core/api/errors'
import { emitChatsChanged } from '@/core/chats-events'
import { ConfirmSheet } from '@/core/ui/ConfirmSheet'
import { Sheet } from '@/core/ui/Sheet'
import { TextPromptSheet } from '@/core/ui/TextPromptSheet'
import {
  CHAT_TITLE_MAX_LENGTH,
  deleteChat,
  renameChat
} from '@/features/library/library-api'

export type ThreadMenuProps = {
  chatId: string
  /** The title the header shows, which the rename prompt starts from. */
  title: string
  /** The chat was renamed; `title` is the one the server saved. */
  onRenamed: (title: string) => void
  /** The chat is gone: leave its screen. */
  onDeleted: () => void
}

type Open = 'menu' | 'rename' | 'delete' | null

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const MENU_ITEM =
  'min-h-12 touch-manipulation rounded-xl px-4 text-left text-base active:bg-muted'

export function ThreadMenu({
  chatId,
  title,
  onRenamed,
  onDeleted
}: ThreadMenuProps) {
  const { client } = useApi()
  const [open, setOpen] = useState<Open>(null)
  const [failure, setFailure] = useState<string>()
  const close = () => setOpen(null)

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
      emitChatsChanged('updated', chatId)
      onRenamed(saved)
    } catch (error) {
      setFailure(`Couldn’t rename the chat. ${reasonOf(error)}`)
    }
  }

  const remove = async () => {
    try {
      await deleteChat(client, chatId)
    } catch (error) {
      // Already gone on the server: that is what the user wanted.
      if (!(error instanceof ApiError && error.status === 404)) {
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
        onClick={() => {
          setFailure(undefined)
          setOpen('menu')
        }}
        className="flex size-11 shrink-0 touch-manipulation items-center justify-center rounded-full text-foreground/70 active:opacity-50"
      >
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
      </button>

      {failure && (
        <div
          role="alert"
          className="absolute inset-x-3 top-full z-10 mt-2 overflow-hidden rounded-2xl bg-background shadow-lg"
        >
          <div className="flex items-center gap-3 bg-red-500/10 px-4 py-1 text-sm text-red-600 dark:text-red-400">
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
            onClick={() => setOpen('rename')}
            className={`${MENU_ITEM} text-foreground`}
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => setOpen('delete')}
            className={`${MENU_ITEM} text-red-600 dark:text-red-400`}
          >
            Delete chat
          </button>
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
