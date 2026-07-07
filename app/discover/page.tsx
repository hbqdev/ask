'use client'

import { useEffect, useState } from 'react'

import { IconCompass } from '@tabler/icons-react'

import { cn } from '@/lib/utils'
import type { DiscoverArticle } from '@/app/api/discover/route'

const CATEGORIES = [
  { id: 'tech', label: 'Tech' },
  { id: 'science', label: 'Science' },
  { id: 'journalism', label: 'Real Journalism' },
  { id: 'gaming', label: 'Gaming' },
  { id: 'sports', label: 'Sports' },
  { id: 'random', label: 'Random' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'deals', label: 'Deals' },
]

function ArticleCard({
  article,
  size = 'normal',
}: {
  article: DiscoverArticle
  size?: 'hero' | 'normal'
}) {
  const summaryUrl = `/?q=${encodeURIComponent(`Summary: ${article.url}`)}`

  if (size === 'hero') {
    return (
      <a
        href={summaryUrl}
        className="group flex flex-col md:flex-row gap-6 rounded-2xl overflow-hidden hover:bg-muted/40 transition-colors p-4 -mx-4"
      >
        {article.image && (
          <div className="md:w-[45%] shrink-0 rounded-xl overflow-hidden">
            <img
              src={article.image}
              alt={article.title}
              className="w-full h-52 md:h-64 object-cover group-hover:scale-[1.02] transition-transform duration-300"
              loading="lazy"
              onError={e => ((e.target as HTMLImageElement).style.display = 'none')}
            />
          </div>
        )}
        <div className="flex flex-col justify-center gap-2">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
            {article.source || 'News'}
          </p>
          <h2 className="text-2xl font-semibold leading-tight group-hover:text-primary transition-colors">
            {article.title}
          </h2>
          {article.excerpt && (
            <p className="text-sm text-muted-foreground line-clamp-3">{article.excerpt}</p>
          )}
        </div>
      </a>
    )
  }

  return (
    <a
      href={summaryUrl}
      className="group flex flex-col rounded-xl overflow-hidden border border-border/60 hover:border-border hover:shadow-sm transition-all bg-card"
    >
      {article.image ? (
        <div className="overflow-hidden">
          <img
            src={article.image}
            alt={article.title}
            className="w-full h-40 object-cover group-hover:scale-[1.03] transition-transform duration-300"
            loading="lazy"
            onError={e => ((e.target as HTMLImageElement).parentElement!.remove())}
          />
        </div>
      ) : (
        <div className="w-full h-40 bg-muted/50 flex items-center justify-center">
          <IconCompass className="size-8 text-muted-foreground/30" />
        </div>
      )}
      <div className="p-3 flex flex-col gap-1.5 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {article.source || 'News'}
        </p>
        <h3 className="text-sm font-semibold leading-snug line-clamp-2 group-hover:text-primary transition-colors">
          {article.title}
        </h3>
        {article.excerpt && (
          <p className="text-xs text-muted-foreground line-clamp-2 mt-auto">{article.excerpt}</p>
        )}
      </div>
    </a>
  )
}

function SkeletonCard({ hero = false }: { hero?: boolean }) {
  if (hero) {
    return (
      <div className="flex flex-col md:flex-row gap-6 p-4 -mx-4">
        <div className="md:w-[45%] h-64 rounded-xl bg-muted animate-pulse" />
        <div className="flex flex-col gap-3 flex-1 justify-center">
          <div className="h-3 w-20 bg-muted rounded animate-pulse" />
          <div className="h-7 w-full bg-muted rounded animate-pulse" />
          <div className="h-7 w-3/4 bg-muted rounded animate-pulse" />
          <div className="h-4 w-full bg-muted rounded animate-pulse" />
          <div className="h-4 w-5/6 bg-muted rounded animate-pulse" />
        </div>
      </div>
    )
  }
  return (
    <div className="rounded-xl border border-border/60 overflow-hidden">
      <div className="h-40 bg-muted animate-pulse" />
      <div className="p-3 flex flex-col gap-2">
        <div className="h-2.5 w-16 bg-muted rounded animate-pulse" />
        <div className="h-4 w-full bg-muted rounded animate-pulse" />
        <div className="h-4 w-4/5 bg-muted rounded animate-pulse" />
      </div>
    </div>
  )
}

export default function DiscoverPage() {
  const [activeCategory, setActiveCategory] = useState('tech')
  const [articles, setArticles] = useState<DiscoverArticle[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    setArticles([])
    fetch(`/api/discover?category=${activeCategory}`)
      .then(r => r.json())
      .then(data => {
        setArticles(data.articles || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [activeCategory])

  const [hero, ...rest] = articles

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-8">
        <div className="flex items-center gap-3">
          <IconCompass className="size-7 text-primary" />
          <h1 className="text-2xl font-bold">Discover</h1>
        </div>
        {/* Category tabs */}
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          {CATEGORIES.map(cat => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={cn(
                'px-3 py-1.5 rounded-full text-sm font-medium transition-colors border',
                activeCategory === cat.id
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'
              )}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {/* Hero article */}
      {loading ? (
        <SkeletonCard hero />
      ) : hero ? (
        <ArticleCard article={hero} size="hero" />
      ) : null}

      {/* Divider */}
      {!loading && articles.length > 1 && <hr className="my-6 border-border/50" />}

      {/* Card grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
          : rest.slice(0, 30).map((article, i) => (
              <ArticleCard key={i} article={article} />
            ))}
      </div>

      {!loading && articles.length === 0 && (
        <div className="text-center text-muted-foreground py-20">
          No articles found for this category.
        </div>
      )}
    </div>
  )
}
