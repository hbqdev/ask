'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { IconDots as Dots, IconTrash as Trash } from '@tabler/icons-react'
import { toast } from 'sonner'

import { deleteChat } from '@/lib/actions/chat'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
import { Spinner } from './ui/spinner'

/**
 * Chat title + options menu, rendered inside the app-wide Header (see
 * ChatHeaderProvider/useChatHeaderInfo) so it lives in that always-on-top,
 * full-width bar rather than a bar that scrolls with the message list.
 */
export function ChatHeader({
  chatId,
  title
}: {
  chatId?: string
  title?: string
}) {
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  if (!chatId) return null

  async function handleDelete() {
    if (isDeleting) return
    setConfirm(false)
    setIsDeleting(true)
    try {
      const result = await deleteChat(chatId!)
      if (result?.success) {
        toast.success('Chat deleted')
        router.push('/')
      } else {
        toast.error(result?.error ?? 'Failed to delete chat')
        setIsDeleting(false)
      }
    } catch (error) {
      console.error('Error deleting chat:', error)
      toast.error('Failed to delete chat')
      setIsDeleting(false)
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 max-w-[45vw] truncate text-sm font-medium text-muted-foreground sm:max-w-xs">
        {title || 'Untitled'}
      </span>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            disabled={isDeleting}
            className="size-7 shrink-0 rounded-lg"
            aria-label="Chat options"
          >
            {isDeleting ? (
              <Spinner className="size-4" />
            ) : (
              <Dots className="size-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            variant="destructive"
            onSelect={event => {
              event.preventDefault()
              setMenuOpen(false)
              setConfirm(true)
            }}
          >
            <Trash className="size-4" />
            <span>Delete</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the entire conversation. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={e => {
                e.preventDefault()
                handleDelete()
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
