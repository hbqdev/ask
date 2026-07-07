'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition
} from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'

import {
  IconLibrary,
  IconSearch,
  IconTrash,
  IconX
} from '@tabler/icons-react'
import { toast } from 'sonner'

import { clearChats, deleteChat } from '@/lib/actions/chat'
import { Chat as DBChat } from '@/lib/db/schema'
import { cn } from '@/lib/utils'

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

interface ChatPageResponse {
  chats: DBChat[]
  nextOffset: number | null
}

function timeAgo(date: Date | string): string {
  const d = new Date(date)
  const now = new Date()
  const secs = Math.floor((now.getTime() - d.getTime()) / 1000)
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function ChatRow({
  chat,
  onDelete
}: {
  chat: DBChat
  onDelete: (id: string) => void
}) {
  const pathname = usePathname()
  const isActive = pathname === `/search/${chat.id}`
  const [confirm, setConfirm] = useState(false)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  const handleDelete = useCallback(() => {
    setConfirm(false)
    startTransition(async () => {
      const result = await deleteChat(chat.id)
      if (result?.success) {
        toast.success('Chat deleted')
        if (isActive) router.push('/library')
        onDelete(chat.id)
      } else {
        toast.error(result?.error ?? 'Failed to delete')
      }
    })
  }, [chat.id, isActive, router, onDelete])

  return (
    <>
      <div
        className={cn(
          'group flex items-center gap-3 px-4 py-3 rounded-xl transition-colors duration-150',
          isActive ? 'bg-primary/8 border border-primary/20' : 'hover:bg-muted/50'
        )}
      >
        <Link
          href={`/search/${chat.id}`}
          className="flex-1 min-w-0 flex flex-col gap-0.5"
        >
          <span
            className={cn(
              'text-sm font-medium truncate leading-snug',
              isActive ? 'text-primary' : 'text-foreground'
            )}
          >
            {chat.title || 'Untitled'}
          </span>
          <span className="text-xs text-muted-foreground">
            {timeAgo(chat.createdAt)}
          </span>
        </Link>

        <button
          onClick={() => setConfirm(true)}
          disabled={isPending}
          className="opacity-0 group-hover:opacity-100 transition-opacity duration-150 p-1.5 rounded-lg hover:bg-destructive/10 hover:text-destructive text-muted-foreground"
          title="Delete chat"
        >
          {isPending ? (
            <Spinner className="size-4" />
          ) : (
            <IconTrash className="size-4" />
          )}
        </button>
      </div>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone.
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
    </>
  )
}

export default function LibraryPage() {
  const router = useRouter()
  const [chats, setChats] = useState<DBChat[]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isPending, startTransition] = useTransition()
  const loadMoreRef = useRef<HTMLDivElement>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<
    { chatId: string; chatTitle: string; snippet: string }[] | null
  >(null)
  const [isSearching, setIsSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const [clearConfirm, setClearConfirm] = useState(false)
  const [isClearing, startClearTransition] = useTransition()

  const fetchInitial = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch('/api/chats?offset=0&limit=30')
      const { chats: data, nextOffset: next } =
        (await res.json()) as ChatPageResponse
      setChats(data)
      setNextOffset(next)
    } catch {
      toast.error('Failed to load chats')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchInitial()
  }, [fetchInitial])

  useEffect(() => {
    const handler = () => startTransition(() => fetchInitial())
    window.addEventListener('chat-history-updated', handler)
    return () => window.removeEventListener('chat-history-updated', handler)
  }, [fetchInitial])

  const fetchMore = useCallback(async () => {
    if (isLoading || nextOffset === null) return
    setIsLoading(true)
    try {
      const res = await fetch(`/api/chats?offset=${nextOffset}&limit=30`)
      const { chats: data, nextOffset: next } =
        (await res.json()) as ChatPageResponse
      setChats(prev => [...prev, ...data])
      setNextOffset(next)
    } catch {
      toast.error('Failed to load more chats')
    } finally {
      setIsLoading(false)
    }
  }, [nextOffset, isLoading])

  useEffect(() => {
    const el = loadMoreRef.current
    if (!el || nextOffset === null || isPending) return
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isLoading) fetchMore()
      },
      { threshold: 0.1 }
    )
    obs.observe(el)
    return () => obs.unobserve(el)
  }, [fetchMore, nextOffset, isLoading, isPending])

  const handleSearch = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value
    setSearchQuery(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!q.trim()) {
      setSearchResults(null)
      return
    }
    debounceRef.current = setTimeout(async () => {
      setIsSearching(true)
      try {
        const res = await fetch(
          `/api/chats/search?q=${encodeURIComponent(q.trim())}`
        )
        const { results } = await res.json()
        setSearchResults(results)
      } catch {
        setSearchResults([])
      } finally {
        setIsSearching(false)
      }
    }, 300)
  }, [])

  const clearSearch = useCallback(() => {
    setSearchQuery('')
    setSearchResults(null)
    searchInputRef.current?.focus()
  }, [])

  const handleDelete = useCallback((id: string) => {
    setChats(prev => prev.filter(c => c.id !== id))
  }, [])

  const handleClearAll = useCallback(() => {
    setClearConfirm(false)
    startClearTransition(async () => {
      const res = await clearChats()
      if (res?.success) {
        toast.success('All chats cleared')
        setChats([])
        setNextOffset(null)
        router.push('/')
      } else {
        toast.error(res?.error ?? 'Failed to clear chats')
      }
    })
  }, [router])

  const isEmpty = !isLoading && chats.length === 0 && nextOffset === null
  const isSearchMode = searchResults !== null || isSearching
  const displayList = isSearchMode ? null : chats

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto w-full px-4 py-8 flex flex-col gap-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2.5">
              <IconLibrary className="size-6 text-primary" />
              <h1 className="text-2xl font-bold">Library</h1>
            </div>
            <p className="text-sm text-muted-foreground">Your past searches</p>
          </div>

          <div className="flex items-center gap-2 mt-1">
            {!isEmpty && (
              <span className="text-xs font-medium text-muted-foreground bg-muted px-2.5 py-1 rounded-full">
                {chats.length}
                {nextOffset !== null ? '+' : ''} chats
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={isEmpty || isClearing}
              onClick={() => setClearConfirm(true)}
              className="text-muted-foreground hover:text-destructive gap-1.5"
            >
              <IconTrash className="size-4" />
              Clear all
            </Button>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={handleSearch}
            placeholder="Search your chats…"
            className="w-full h-10 pl-9 pr-9 text-sm rounded-xl border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 transition-shadow"
          />
          {searchQuery && (
            <button
              onClick={clearSearch}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <IconX className="size-4" />
            </button>
          )}
        </div>

        {/* Content */}
        {isSearchMode ? (
          <div className="flex flex-col gap-1">
            {isSearching && (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            )}
            {!isSearching && searchResults !== null && searchResults.length === 0 && (
              <p className="text-center text-muted-foreground text-sm py-8">
                No results for &ldquo;{searchQuery}&rdquo;
              </p>
            )}
            {!isSearching &&
              searchResults &&
              searchResults.map(r => (
                <Link
                  key={r.chatId}
                  href={`/search/${r.chatId}`}
                  className="flex flex-col gap-0.5 px-4 py-3 rounded-xl hover:bg-muted/50 transition-colors"
                >
                  <span className="text-sm font-medium text-foreground truncate">
                    {r.chatTitle}
                  </span>
                  {r.snippet && r.snippet !== r.chatTitle && (
                    <span className="text-xs text-muted-foreground line-clamp-2">
                      {r.snippet}
                    </span>
                  )}
                </Link>
              ))}
          </div>
        ) : isLoading && chats.length === 0 ? (
          <div className="flex flex-col gap-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="flex flex-col gap-1.5 px-4 py-3 rounded-xl"
              >
                <div className="h-4 w-3/4 bg-muted rounded animate-pulse" />
                <div className="h-3 w-1/4 bg-muted rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : isEmpty ? (
          <div className="flex flex-col items-center gap-3 py-20 text-muted-foreground">
            <IconLibrary className="size-10 opacity-20" />
            <p className="text-sm">No chats yet</p>
            <Link href="/">
              <Button variant="outline" size="sm">
                Start searching
              </Button>
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {displayList!.map(chat => (
              <ChatRow key={chat.id} chat={chat} onDelete={handleDelete} />
            ))}
            <div ref={loadMoreRef} style={{ height: '1px' }} />
            {(isLoading || isPending) && (
              <div className="flex justify-center py-4">
                <Spinner />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Clear all confirmation */}
      <AlertDialog open={clearConfirm} onOpenChange={setClearConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all chats?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes all your chat history and cannot be
              undone.
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
              {isClearing ? <Spinner /> : 'Clear all'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
