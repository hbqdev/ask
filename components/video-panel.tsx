'use client'

import { useState } from 'react'

import {
  IconChevronDown,
  IconChevronUp,
  IconMovie
} from '@tabler/icons-react'

import { cn } from '@/lib/utils'

interface VideoResult {
  title: string
  url: string
  thumbnail: string
  engine: string
  publishedDate: string | null
}

interface VideoPanelProps {
  query: string
  className?: string
}

export function VideoPanel({ query, className }: VideoPanelProps) {
  const [videos, setVideos] = useState<VideoResult[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [fetched, setFetched] = useState(false)

  // Lazy fetch on expand
  const handleExpand = async () => {
    if (!fetched) {
      setLoading(true)
      try {
        const res = await fetch(`/api/videos?q=${encodeURIComponent(query)}`)
        const data = await res.json()
        setVideos(data.videos || [])
      } catch {
        setVideos([])
      } finally {
        setLoading(false)
        setFetched(true)
      }
    }
    setExpanded(v => !v)
  }

  if (!query) return null

  return (
    <div className={cn('border border-border/50 rounded-xl overflow-hidden', className)}>
      {/* Header - always visible, clickable to expand */}
      <button
        type="button"
        onClick={handleExpand}
        className="flex items-center justify-between w-full px-4 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2 text-sm font-medium">
          <IconMovie className="size-4 text-red-500" />
          <span>Videos</span>
          {fetched && videos.length > 0 && (
            <span className="text-xs text-muted-foreground">({videos.length})</span>
          )}
        </div>
        {loading ? (
          <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin" />
        ) : expanded ? (
          <IconChevronUp className="size-4 text-muted-foreground" />
        ) : (
          <IconChevronDown className="size-4 text-muted-foreground" />
        )}
      </button>

      {/* Video grid - only shown when expanded */}
      {expanded && !loading && (
        <div className="p-3">
          {videos.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No videos found</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {videos.map((video, i) => (
                <a
                  key={i}
                  href={video.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group relative block rounded-lg overflow-hidden border border-border/50 hover:border-border transition-colors"
                >
                  {/* Thumbnail */}
                  <div className="relative aspect-video bg-muted">
                    {video.thumbnail ? (
                      <img
                        src={video.thumbnail}
                        alt={video.title}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <IconMovie className="size-8 text-muted-foreground" />
                      </div>
                    )}
                    {/* Play overlay */}
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/40 transition-opacity">
                      <div className="rounded-full bg-white/90 p-2">
                        <svg className="size-4 text-black fill-current ml-0.5" viewBox="0 0 24 24">
                          <path d="M8 5v14l11-7z"/>
                        </svg>
                      </div>
                    </div>
                  </div>
                  {/* Title */}
                  <div className="p-1.5">
                    <p className="text-xs font-medium line-clamp-2 leading-tight">{video.title}</p>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
