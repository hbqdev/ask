'use client'

import { useEffect, useState, useTransition } from 'react'

import { IconTrash } from '@tabler/icons-react'
import { toast } from 'sonner'

import {
  clearMemoriesAction,
  deleteMemoryAction,
  getMemories,
  getMemoryEnabled,
  setMemoryEnabledAction
} from '@/lib/actions/memory'
import type { UserMemory } from '@/lib/db/schema'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

import { SettingRow, SettingSwitch } from '@/components/settings-dialog'

export function MemoryTab() {
  const [enabled, setEnabled] = useState(true)
  const [memories, setMemories] = useState<UserMemory[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [clearOpen, setClearOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [memoryEnabled, userMemories] = await Promise.all([
        getMemoryEnabled(),
        getMemories()
      ])
      if (cancelled) return
      setEnabled(memoryEnabled)
      setMemories(userMemories)
      setIsLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleToggle = (next: boolean) => {
    const previous = enabled
    setEnabled(next)
    startTransition(async () => {
      const result = await setMemoryEnabledAction(next)
      if (!result.success) {
        setEnabled(previous)
        toast.error(result.error || 'Failed to update memory setting')
      }
    })
  }

  const handleDelete = (id: string) => {
    startTransition(async () => {
      const result = await deleteMemoryAction(id)
      if (result.success) {
        setMemories(prev => prev.filter(m => m.id !== id))
      } else {
        toast.error(result.error || 'Failed to delete memory')
      }
    })
  }

  const handleClearAll = () => {
    startTransition(async () => {
      const result = await clearMemoriesAction()
      if (result.success) {
        setMemories([])
        toast.success('All memories cleared')
      } else {
        toast.error(result.error || 'Failed to clear memories')
      }
      setClearOpen(false)
    })
  }

  return (
    <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
      <SettingRow
        title="Memory"
        description="Let Ask remember useful details about you across chats."
        inline
      >
        <SettingSwitch checked={enabled} onChange={handleToggle} />
      </SettingRow>

      <SettingRow
        title="What Ask remembers"
        description="Review and remove anything Ask has learned about you."
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Spinner className="size-5" />
          </div>
        ) : memories.length === 0 ? (
          <p className="text-xs text-foreground/50">No memories yet.</p>
        ) : (
          <ul className="space-y-2">
            {memories.map(memory => (
              <li
                key={memory.id}
                className="group flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="truncate text-xs text-foreground/80 lg:text-sm">
                    {memory.content}
                  </p>
                  <span className="text-[10px] uppercase tracking-wide text-foreground/40">
                    {memory.status === 'confirmed' ? 'confirmed' : 'learning'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(memory.id)}
                  disabled={isPending}
                  className="shrink-0 rounded-lg p-1.5 text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                  title="Delete memory"
                >
                  <IconTrash className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </SettingRow>

      {memories.length > 0 && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setClearOpen(true)}
            disabled={isPending}
          >
            Clear all
          </Button>
        </div>
      )}

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all memories?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes everything Ask has remembered about you.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={e => {
                e.preventDefault()
                handleClearAll()
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Clear all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
