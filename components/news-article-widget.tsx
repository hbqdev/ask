'use client'

import { useEffect, useState } from 'react'

import { IconSparkles } from '@tabler/icons-react'

import { SUMMARIZE_LABEL } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { rotateWindow } from '@/lib/utils/rotate-window'

interface Article {
  title: string
  content: string
  url: string
  thumbnail: string
  category?: string
}

// Keep a small pool so the widget can rotate through fresh headlines. The mix
// endpoint samples one article per category, so this is the variety on offer.
const POOL_MAX = 8
// Auto-advance interval — the same on every interface, per product decision.
const CYCLE_MS = 20000
// Below the `sm` breakpoint the widget shows ONE article (it stacks under the
// weather card on phones); at/above it shows three. Matches the widget-row
// stacking in chat-panel.
const SM_QUERY = '(min-width: 640px)'

function useIsWide() {
  // Default to the desktop count so SSR and the first client render agree
  // (avoids a hydration mismatch); corrected on mount.
  const [wide, setWide] = useState(true)
  useEffect(() => {
    const mql = window.matchMedia(SM_QUERY)
    const sync = () => setWide(mql.matches)
    sync()
    mql.addEventListener('change', sync)
    return () => mql.removeEventListener('change', sync)
  }, [])
  return wide
}

function thumbUrl(raw: string) {
  try {
    const u = new URL(raw)
    if (u.hostname.includes('bing.com') && u.searchParams.has('id')) {
      return `${u.origin}${u.pathname}?id=${u.searchParams.get('id')}`
    }
    return raw
  } catch {
    return raw
  }
}

function summaryHref(url: string) {
  return `/?q=${encodeURIComponent(`Summary: ${url}`)}`
}

export function NewsArticleWidget({ className }: { className?: string }) {
  const [pool, setPool] = useState<Article[]>([])
  const [loading, setLoading] = useState(true)
  const [start, setStart] = useState(0)
  const [paused, setPaused] = useState(false)
  const isWide = useIsWide()
  const count = isWide ? 3 : 1

  useEffect(() => {
    // The mix endpoint returns at most one article per category, already in
    // random order, so the rotating headlines span different topics.
    fetch('/api/discover?topic=mix&mode=preview')
      .then(r => r.json())
      .then(data => {
        const all: Article[] = data.blogs || []
        const withThumbnail = all.filter(a => a.thumbnail).slice(0, POOL_MAX)
        setPool(withThumbnail)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Cycle every 20s by sliding the window one article forward. Only runs when
  // there is more to show than currently fits, so a short feed stays static.
  useEffect(() => {
    if (pool.length <= count || paused) return
    // Honor reduced-motion: don't auto-advance content for users who opt out
    // (WCAG 2.2.2). Hovering the widget also pauses it (see onMouseEnter).
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const id = setInterval(() => setStart(s => (s + 1) % pool.length), CYCLE_MS)
    return () => clearInterval(id)
  }, [pool.length, count, paused])

  if (loading) {
    return (
      <div
        className={cn(
          'rounded-2xl bg-muted/50 animate-pulse w-full h-40 sm:h-64',
          className
        )}
      />
    )
  }

  if (pool.length === 0) return null

  const articles = rotateWindow(pool, start, count)

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={cn(
        'rounded-2xl border border-border/50 bg-card/80 backdrop-blur-sm w-full h-auto sm:h-64 flex flex-col overflow-hidden select-none divide-y divide-border/50',
        className
      )}
    >
      {articles.map(article => (
        <div
          key={article.url}
          className="group relative flex flex-1 min-h-0 flex-row items-center gap-3 px-3 py-2 sm:py-0 animate-in fade-in-0 hover:bg-muted/40 transition-colors duration-200"
        >
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex flex-1 min-w-0 flex-row items-center gap-3"
          >
            <div className="size-14 min-w-14 shrink-0 overflow-hidden rounded-lg">
              <img
                src={thumbUrl(article.thumbnail)}
                alt={article.title}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              />
            </div>
            <div className="flex-1 min-w-0 pr-7">
              <p className="text-sm font-semibold leading-snug line-clamp-2 group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors duration-200">
                {article.title}
              </p>
              <div className="mt-0.5 flex items-center gap-1.5 min-w-0">
                {article.category && (
                  <span className="shrink-0 rounded bg-cyan-500/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">
                    {article.category}
                  </span>
                )}
                <span className="truncate text-xs text-muted-foreground leading-snug">
                  {article.content}
                </span>
              </div>
            </div>
          </a>
          <a
            href={summaryHref(article.url)}
            title={SUMMARIZE_LABEL}
            aria-label={SUMMARIZE_LABEL}
            className="absolute right-3 top-1/2 -translate-y-1/2 flex size-6 shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/25 border border-cyan-500/30"
          >
            <IconSparkles className="size-3.5" />
          </a>
        </div>
      ))}
    </div>
  )
}
