'use client'

import { useEffect, useState } from 'react'

import { IconSparkles } from '@tabler/icons-react'

import { SUMMARIZE_LABEL } from '@/lib/constants'
import { cn } from '@/lib/utils'

interface Article {
  title: string
  content: string
  url: string
  thumbnail: string
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
  const [hero, setHero] = useState<Article | null>(null)
  const [more, setMore] = useState<Article[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/discover?topic=tech&mode=preview')
      .then(r => r.json())
      .then(data => {
        const all: Article[] = data.blogs || []
        const withThumbnail = all.filter(a => a.thumbnail)
        if (withThumbnail.length === 0) return

        const heroArticle =
          withThumbnail[Math.floor(Math.random() * withThumbnail.length)]
        setHero(heroArticle)
        setMore(
          withThumbnail.filter(a => a.url !== heroArticle.url).slice(0, 2)
        )
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div
        className={cn(
          'rounded-2xl bg-muted/50 animate-pulse w-full h-64',
          className
        )}
      />
    )
  }

  if (!hero) return null

  const articles = [hero, ...more]

  return (
    <div
      className={cn(
        'rounded-2xl border border-border/50 bg-card/80 backdrop-blur-sm w-full h-64 flex flex-col overflow-hidden select-none divide-y divide-border/50',
        className
      )}
    >
      {articles.map(article => (
        <div
          key={article.url}
          className="group relative flex-1 min-h-0 flex flex-row items-center gap-3 px-3 hover:bg-muted/40 transition-colors duration-200"
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
              <p className="text-xs text-muted-foreground leading-snug line-clamp-1 mt-0.5">
                {article.content}
              </p>
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
