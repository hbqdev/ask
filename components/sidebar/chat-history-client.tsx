'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'

import { IconSearch as Search, IconX as X } from '@tabler/icons-react'
import { toast } from 'sonner'

import { Chat as DBChat } from '@/lib/db/schema'

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu
} from '@/components/ui/sidebar'

import { ChatHistorySkeleton } from './chat-history-skeleton'
import { ChatMenuItem } from './chat-menu-item'
import { ClearHistoryAction } from './clear-history-action'

interface ChatPageResponse {
  chats: DBChat[]
  nextOffset: number | null
}

interface SearchResult {
  chatId: string
  chatTitle: string
  snippet: string
  role: string
  lastViewedAt: string | null
}

function highlightMatch(text: string, query: string) {
  if (!query) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-200 dark:bg-yellow-700 text-inherit rounded-sm px-0.5">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  )
}

export function ChatHistoryClient() {
  const [chats, setChats] = useState<DBChat[]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const [isPending, startTransition] = useTransition()

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(
    null
  )
  const [isSearching, setIsSearching] = useState(false)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const fetchInitialChats = useCallback(async () => {
    setIsLoading(true)
    try {
      const response = await fetch(`/api/chats?offset=0&limit=20`)
      if (!response.ok) {
        throw new Error('Failed to fetch initial chat history')
      }
      const { chats: dbChats, nextOffset: newNextOffset } =
        (await response.json()) as ChatPageResponse

      setChats(dbChats)
      setNextOffset(newNextOffset)
    } catch (error) {
      console.error('Failed to load initial chats:', error)
      toast.error('Failed to load chat history.')
      setNextOffset(null)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchInitialChats()
  }, [fetchInitialChats])

  useEffect(() => {
    const handleHistoryUpdate = () => {
      startTransition(async () => {
        await fetchInitialChats()
      })
    }
    window.addEventListener('chat-history-updated', handleHistoryUpdate)
    return () => {
      window.removeEventListener('chat-history-updated', handleHistoryUpdate)
    }
  }, [fetchInitialChats, startTransition])

  useEffect(() => {
    const handleBump = (e: Event) => {
      const chatId = (e as CustomEvent<{ chatId: string }>).detail?.chatId
      if (!chatId) return
      setChats(prev => {
        const idx = prev.findIndex(c => c.id === chatId)
        if (idx <= 0) return prev
        const bumped = prev[idx]
        return [bumped, ...prev.filter((_, i) => i !== idx)]
      })
    }
    window.addEventListener('chat-bump', handleBump)
    return () => window.removeEventListener('chat-bump', handleBump)
  }, [])

  const fetchMoreChats = useCallback(async () => {
    if (isLoading || nextOffset === null) return

    setIsLoading(true)
    try {
      const response = await fetch(`/api/chats?offset=${nextOffset}&limit=20`)
      if (!response.ok) {
        throw new Error('Failed to fetch more chat history')
      }
      const { chats: dbChats, nextOffset: newNextOffset } =
        (await response.json()) as ChatPageResponse

      setChats(prevChats => [...prevChats, ...dbChats])
      setNextOffset(newNextOffset)
    } catch (error) {
      console.error('Failed to load more chats:', error)
      toast.error('Failed to load more chat history.')
      setNextOffset(null)
    } finally {
      setIsLoading(false)
    }
  }, [nextOffset, isLoading])

  useEffect(() => {
    const observerRefValue = loadMoreRef.current
    if (!observerRefValue || nextOffset === null || isPending) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isLoading && !isPending) {
          fetchMoreChats()
        }
      },
      { threshold: 0.1 }
    )

    observer.observe(observerRefValue)

    return () => {
      if (observerRefValue) {
        observer.unobserve(observerRefValue)
      }
    }
  }, [fetchMoreChats, nextOffset, isLoading, isPending])

  // Debounced search
  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const q = e.target.value
      setSearchQuery(q)

      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current)
      }

      if (!q.trim()) {
        setSearchResults(null)
        return
      }

      searchDebounceRef.current = setTimeout(async () => {
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
    },
    []
  )

  const clearSearch = useCallback(() => {
    setSearchQuery('')
    setSearchResults(null)
    searchInputRef.current?.focus()
  }, [])

  const isHistoryEmpty = !isLoading && !chats.length && nextOffset === null
  const isSearchMode = searchResults !== null || isSearching

  return (
    <div className="flex flex-col flex-1 h-full">
      <SidebarGroup>
        <div className="flex items-center justify-between w-full">
          <SidebarGroupLabel className="p-0">History</SidebarGroupLabel>
          <ClearHistoryAction empty={isHistoryEmpty} />
        </div>

        {/* Search input */}
        <div className="relative mt-1.5 mb-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={handleSearchChange}
            placeholder="Search history…"
            className="w-full h-7 pl-7 pr-7 text-xs rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {searchQuery && (
            <button
              onClick={clearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </SidebarGroup>

      <div className="flex-1 overflow-y-auto mb-2 relative">
        {/* Search results */}
        {isSearchMode ? (
          <>
            {isSearching && (
              <div className="py-2">
                <ChatHistorySkeleton />
              </div>
            )}
            {!isSearching &&
              searchResults !== null &&
              searchResults.length === 0 && (
                <div className="px-2 text-foreground/30 text-sm text-center py-4">
                  No results for &ldquo;{searchQuery}&rdquo;
                </div>
              )}
            {!isSearching && searchResults && searchResults.length > 0 && (
              <SidebarMenu>
                {searchResults.map(result => (
                  <li key={result.chatId} className="list-none">
                    <a
                      href={`/search/${result.chatId}`}
                      className="flex flex-col gap-0.5 px-2 py-2 rounded-md hover:bg-accent text-sm transition-colors"
                    >
                      <span className="font-medium text-foreground truncate">
                        {highlightMatch(result.chatTitle, searchQuery)}
                      </span>
                      {result.snippet &&
                        result.snippet !== result.chatTitle && (
                          <span className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                            {highlightMatch(result.snippet, searchQuery)}
                          </span>
                        )}
                    </a>
                  </li>
                ))}
              </SidebarMenu>
            )}
          </>
        ) : (
          /* Normal history list */
          <>
            {isHistoryEmpty && !isPending ? (
              <div className="px-2 text-foreground/30 text-sm text-center py-4">
                No search history
              </div>
            ) : (
              <SidebarMenu>
                {chats.map(
                  (chat: DBChat) =>
                    chat && <ChatMenuItem key={chat.id} chat={chat} />
                )}
              </SidebarMenu>
            )}
            <div ref={loadMoreRef} style={{ height: '1px' }} />
            {(isLoading || isPending) && (
              <div className="py-2">
                <ChatHistorySkeleton />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
