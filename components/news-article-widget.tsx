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

export function NewsArticleWidget({ className }: { className?: string }) {
  const [article, setArticle] = useState<Article | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/discover?topic=tech&mode=preview')
      .then(r => r.json())
      .then(data => {
        const articles = (data.blogs || []).filter((a: Article) => a.thumbnail)
        if (articles.length > 0) {
          setArticle(articles[Math.floor(Math.random() * articles.length)])
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className={cn('rounded-2xl bg-muted/50 animate-pulse w-full h-24', className)} />
    )
  }

  if (!article) return null

  return (
    <a
      href={`/?q=${encodeURIComponent(`Summary: ${article.url}`)}`}
      className={cn(
        'group rounded-2xl border border-border/50 bg-card/80 backdrop-blur-sm w-full h-24 flex flex-row items-stretch overflow-hidden select-none hover:border-border transition-colors duration-200',
        className
      )}
    >
      <div className="w-24 min-w-24 shrink-0 overflow-hidden">
        <img
          src={thumbUrl(article.thumbnail)}
          alt={article.title}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
        />
      </div>
      <div className="flex-1 px-3 py-2 flex flex-col justify-center min-w-0">
        <p className="text-xs font-semibold leading-snug line-clamp-2 group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors duration-200">
          {article.title}
        </p>
        <p className="text-[10px] text-muted-foreground leading-snug line-clamp-2 mt-0.5">
          {article.content}
        </p>
      </div>
    </a>
  )
}
