'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

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

// The Discover briefing shows a single row of category-tagged cards. Capping at
// 4 keeps the wide (lg) layout to exactly one clean row of the responsive
// 4-column grid — no orphan second row. Narrower breakpoints still wrap.
const MAX_CARDS = 4

// We gather a larger POOL of thumbnailed articles up front, then randomly pick
// MAX_CARDS from it per page load, so a refresh surfaces a different set rather
// than always the same first 4. The pool is capped to keep the shuffle cheap.
const POOL_MAX = 12

// Auto-advance interval — the same cadence as the news widget, per product
// decision. Every CYCLE_MS the visible window slides forward across the pool so
// fresh headlines surface without a reload.
const CYCLE_MS = 20000

// Category → accent color, matching the home mockup's palette. Keys are the
// human labels the mix feed emits (see TOPIC_LABELS in app/api/discover). An
// unknown label still gets a stable color via a deterministic hue hash, so the
// tag and placeholder never fall back to a flat gray.
const CATEGORY_COLORS: Record<string, string> = {
  world: '#8ab0ff',
  tech: '#c99bff',
  science: '#6fe0c0',
  finance: '#7ee0b6',
  'art & culture': '#ff85ac',
  sports: '#ffcf7a',
  entertainment: '#ffca8a',
  gaming: '#a596f5',
  health: '#8ecdf5'
}

function categoryColor(category?: string): string {
  if (!category) return '#9ea0d8'
  const key = category.trim().toLowerCase()
  if (CATEGORY_COLORS[key]) return CATEGORY_COLORS[key]
  // Stable hue from the label so repeat renders don't shuffle colors.
  let hue = 0
  for (let i = 0; i < key.length; i++) hue = (hue * 31 + key.charCodeAt(i)) % 360
  return `hsl(${hue} 70% 72%)`
}

// A subtle gradient derived from the category color, used both as the thumbnail
// placeholder (when the image is missing or fails) and behind it while loading.
function placeholderGradient(category?: string): string {
  const c = categoryColor(category)
  return `linear-gradient(135deg, color-mix(in oklab, ${c} 55%, #16141f), color-mix(in oklab, ${c} 16%, #100e18))`
}

// Some sources (Bing) hand back tracking-laden thumbnail URLs; keep only the
// stable `id` param so the same image loads reliably. Mirrors the news widget.
function thumbUrl(raw: string): string {
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

// Short, human source label from the article URL (e.g. "reuters.com"), shown as
// the card's source line — the feed carries no dedicated source/time field.
function sourceLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// Deep-link that opens an Ask summary of the article. Mirrors the news widget's
// format exactly so both entry points behave identically.
function summaryHref(url: string): string {
  return `/?q=${encodeURIComponent(`Summary: ${url}`)}`
}

export function DiscoverBriefing({ className }: { className?: string }) {
  // Keep the whole shuffled pool (up to POOL_MAX) so the row can auto-rotate
  // through it; the visible MAX_CARDS are a sliding window into this pool.
  const [pool, setPool] = useState<Article[]>([])
  const [loading, setLoading] = useState(true)
  // Thumbnails come from arbitrary domains and often 404; track the failures so
  // those cards fall back to the gradient placeholder instead of a broken img.
  const [failed, setFailed] = useState<Set<string>>(new Set())
  // Window offset into the pool; advanced by the auto-rotation timer.
  const [start, setStart] = useState(0)
  // Hovering the row pauses rotation so a card can be read/clicked in peace.
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    // Reuse the same mixed-preview feed as the rotating news widget: one
    // article per category, already shuffled, so the row spans topics.
    fetch('/api/discover?topic=mix&mode=preview')
      .then(r => r.json())
      .then(data => {
        const all: Article[] = data.blogs || []
        // Build a pool of thumbnailed articles and shuffle it, so each fresh
        // load surfaces a different set. Runs post-mount (server renders only
        // the skeleton), so there's no SSR/hydration mismatch. Fisher–Yates on
        // a copy; the shuffled pool lives in state so it stays put across
        // re-renders and only reshuffles on a real refresh. The visible 4 are a
        // window into it that the auto-rotation slides forward.
        const shuffled = all.filter(a => a.thumbnail).slice(0, POOL_MAX)
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
        }
        setPool(shuffled)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Every CYCLE_MS, slide the window forward by a full page (MAX_CARDS) so the
  // visible row swaps to a different set of articles from the pool. Only runs
  // when the pool holds more than fits, so a short feed stays static.
  useEffect(() => {
    if (pool.length <= MAX_CARDS || paused) return
    // Honor reduced-motion: don't auto-advance content for users who opt out
    // (WCAG 2.2.2). Hovering the row also pauses it (see onMouseEnter).
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const id = setInterval(
      () => setStart(s => (s + MAX_CARDS) % pool.length),
      CYCLE_MS
    )
    return () => clearInterval(id)
  }, [pool.length, paused])

  if (loading) {
    return (
      <section className={cn('w-full', className)}>
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Today · Discover
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="overflow-hidden rounded-2xl border border-border/50 bg-card/60"
            >
              <div className="h-24 w-full animate-pulse bg-muted/50" />
              <div className="space-y-2 px-3 py-3">
                <div className="h-2.5 w-12 animate-pulse rounded bg-muted/50" />
                <div className="h-3 w-full animate-pulse rounded bg-muted/50" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-muted/50" />
              </div>
            </div>
          ))}
        </div>
      </section>
    )
  }

  // Nothing to show — render nothing so the homepage has no empty section.
  if (pool.length === 0) return null

  const items = rotateWindow(pool, start, MAX_CARDS)

  return (
    <section className={cn('w-full', className)}>
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          Today · Discover
        </span>
        <Link
          href="/discover"
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          See all →
        </Link>
      </div>

      <div
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        {items.map(article => {
          const color = categoryColor(article.category)
          const showPlaceholder = failed.has(article.url) || !article.thumbnail
          const source = sourceLabel(article.url)
          return (
            <div
              key={article.url}
              className="group relative flex flex-col overflow-hidden rounded-2xl border border-border/50 bg-card/60 backdrop-blur-sm transition-[transform,background-color] duration-200 animate-in fade-in-0 hover:-translate-y-1 hover:bg-card/80"
            >
              {/* Primary outbound link — covers the whole card. A separate
                  anchor (rather than wrapping everything) so the Ask Summary
                  button below can be its own link without nesting anchors. */}
              <a
                href={article.url}
                target="_blank"
                rel="noreferrer"
                aria-label={article.title}
                className="absolute inset-0 z-0"
              />

              <div className="h-24 w-full overflow-hidden">
                {showPlaceholder ? (
                  <div
                    className="h-full w-full"
                    style={{ background: placeholderGradient(article.category) }}
                  />
                ) : (
                  <img
                    src={thumbUrl(article.thumbnail)}
                    alt=""
                    loading="lazy"
                    onError={() =>
                      setFailed(prev => {
                        const next = new Set(prev)
                        next.add(article.url)
                        return next
                      })
                    }
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                )}
              </div>

              <div className="flex flex-col px-3 py-3">
                {article.category && (
                  <span
                    className="font-mono text-[10px] font-medium uppercase tracking-[0.1em]"
                    style={{ color }}
                  >
                    {article.category}
                  </span>
                )}
                <h4 className="mt-1 line-clamp-2 text-[13.5px] font-semibold leading-[1.28] tracking-[-0.01em] text-foreground">
                  {article.title}
                </h4>
                {source && (
                  <div className="mt-1.5 truncate text-[11px] text-muted-foreground">
                    {source}
                  </div>
                )}
              </div>

              {/* Ask Summary — opens a summary of this article in Ask. Sits
                  above the card link (higher z-index) and stops propagation so
                  a click here never also triggers the outbound link. */}
              <a
                href={summaryHref(article.url)}
                title={SUMMARIZE_LABEL}
                aria-label={SUMMARIZE_LABEL}
                onClick={e => e.stopPropagation()}
                className="absolute right-2 top-2 z-10 flex size-7 items-center justify-center rounded-full bg-black/55 text-white shadow-md ring-1 ring-white/25 backdrop-blur-md transition hover:bg-violet-600/85 hover:ring-white/50"
              >
                <IconSparkles className="size-4" />
              </a>
            </div>
          )
        })}
      </div>
    </section>
  )
}
