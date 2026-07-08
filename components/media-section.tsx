'use client'

import { useEffect, useRef, useState } from 'react'

import {
  IconPhoto,
  IconPlayerPlay,
  IconMovie,
  IconX
} from '@tabler/icons-react'

import { cn } from '@/lib/utils'

interface ImageResult {
  img_src: string
  url: string
  title: string
}

interface VideoResult {
  title: string
  url: string
  thumbnail: string
  engine: string
  publishedDate: string | null
}

interface MediaSectionProps {
  query: string
  model?: string
  className?: string
}

type Tab = 'images' | 'videos'

export function MediaSection({ query, model, className }: MediaSectionProps) {
  const [tab, setTab] = useState<Tab>('images')
  const [images, setImages] = useState<ImageResult[]>([])
  const [videos, setVideos] = useState<VideoResult[]>([])
  const [loadingImages, setLoadingImages] = useState(true)
  const [loadingVideos, setLoadingVideos] = useState(true)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (fetchedRef.current || !query) return
    fetchedRef.current = true

    const body = model ? { query, model } : { query }

    fetch('/api/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(r => r.json())
      .then(d => setImages(d.images || []))
      .catch(() => setImages([]))
      .finally(() => setLoadingImages(false))

    fetch('/api/videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(r => r.json())
      .then(d => setVideos(d.videos || []))
      .catch(() => setVideos([]))
      .finally(() => setLoadingVideos(false))
  }, [query, model])

  if (!query) return null

  const isLoading = tab === 'images' ? loadingImages : loadingVideos

  return (
    <div className={cn('mt-4 rounded-xl border border-border/50 overflow-hidden', className)}>
      {/* Tab header */}
      <div className="flex border-b border-border/50 bg-muted/20">
        <button
          type="button"
          onClick={() => setTab('images')}
          className={cn(
            'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors',
            tab === 'images'
              ? 'border-b-2 border-primary text-primary -mb-px'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <IconPhoto className="size-4" />
          Images
          {!loadingImages && images.length > 0 && (
            <span className="text-xs text-muted-foreground">({images.length})</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setTab('videos')}
          className={cn(
            'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors',
            tab === 'videos'
              ? 'border-b-2 border-primary text-primary -mb-px'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <IconMovie className="size-4" />
          Videos
          {!loadingVideos && videos.length > 0 && (
            <span className="text-xs text-muted-foreground">({videos.length})</span>
          )}
        </button>
      </div>

      {/* Content */}
      <div className="p-3">
        {isLoading ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  'rounded-lg bg-muted animate-pulse',
                  tab === 'images' ? 'aspect-square' : 'aspect-video'
                )}
              />
            ))}
          </div>
        ) : tab === 'images' ? (
          images.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No images found</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {images.map((img, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setLightboxSrc(img.img_src)}
                  className="group relative block rounded-lg overflow-hidden border border-border/50 hover:border-border transition-colors aspect-square bg-muted"
                  title={img.title}
                >
                  <img
                    src={img.img_src}
                    alt={img.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    loading="lazy"
                    onError={e => {
                      ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                    }}
                  />
                </button>
              ))}
            </div>
          )
        ) : videos.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">No videos found</p>
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
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/40 transition-opacity">
                    <div className="rounded-full bg-white/90 p-2">
                      <IconPlayerPlay className="size-4 text-black fill-current" />
                    </div>
                  </div>
                </div>
                <div className="p-1.5">
                  <p className="text-xs font-medium line-clamp-2 leading-tight">{video.title}</p>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightboxSrc(null)}
        >
          <button
            type="button"
            className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 transition-colors"
            onClick={() => setLightboxSrc(null)}
          >
            <IconX className="size-5" />
          </button>
          <img
            src={lightboxSrc}
            alt="Preview"
            className="max-w-full max-h-full object-contain rounded-lg"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}
