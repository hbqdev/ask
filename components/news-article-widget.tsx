'use client'

import { useEffect, useState } from 'react'

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
        setMore(all.filter(a => a.url !== heroArticle.url).slice(0, 2))
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

  return (
    <div
      className={cn(
        'rounded-2xl border border-border/50 bg-card/80 backdrop-blur-sm w-full h-64 flex flex-col overflow-hidden select-none',
        className
      )}
    >
      <a
        href={summaryHref(hero.url)}
        className="group flex flex-row items-stretch overflow-hidden hover:bg-muted/40 transition-colors duration-200 h-36 shrink-0"
      >
        <div className="w-32 min-w-32 shrink-0 overflow-hidden">
          <img
            src={thumbUrl(hero.thumbnail)}
            alt={hero.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        </div>
        <div className="flex-1 px-3 py-2.5 flex flex-col justify-center min-w-0">
          <p className="text-sm font-semibold leading-snug line-clamp-2 group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors duration-200">
            {hero.title}
          </p>
          <p className="text-xs text-muted-foreground leading-snug line-clamp-2 mt-1">
            {hero.content}
          </p>
        </div>
      </a>

      {more.length > 0 && (
        <div className="flex-1 min-h-0 border-t border-border/50 px-3 py-2 flex flex-col justify-center gap-1.5">
          {more.map(article => (
            <a
              key={article.url}
              href={summaryHref(article.url)}
              className="text-xs leading-snug line-clamp-1 text-muted-foreground hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors duration-200"
            >
              {article.title}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
