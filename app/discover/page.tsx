'use client'

import { useEffect, useState } from 'react'

import { IconWorld } from '@tabler/icons-react'

import { cn } from '@/lib/utils'

import type { DiscoverArticle } from '@/app/api/discover/route'

const TOPICS = [
  { key: 'tech', label: 'Tech & Science' },
  { key: 'finance', label: 'Finance' },
  { key: 'art', label: 'Art & Culture' },
  { key: 'sports', label: 'Sports' },
  { key: 'entertainment', label: 'Entertainment' },
]

function articleLink(url: string) {
  return `/?q=${encodeURIComponent(`Summary: ${url}`)}`
}

function MajorCard({ item, imageLeft = true }: { item: DiscoverArticle; imageLeft?: boolean }) {
  return (
    <a
      href={articleLink(item.url)}
      className="w-full group flex flex-row items-stretch gap-6 h-60 py-3"
    >
      {imageLeft ? (
        <>
          <div className="relative w-72 xl:w-80 shrink-0 h-full overflow-hidden rounded-2xl">
            <img
              className="object-cover w-full h-full group-hover:scale-105 transition-transform duration-500"
              src={item.thumbnail}
              alt={item.title}
              loading="lazy"
            />
          </div>
          <div className="flex flex-col justify-center flex-1 py-2 min-w-0">
            <h2 className="text-2xl xl:text-3xl font-light mb-3 leading-tight line-clamp-3 group-hover:text-primary transition-colors duration-200">
              {item.title}
            </h2>
            <p className="text-muted-foreground text-sm leading-relaxed line-clamp-4">
              {item.content}
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col justify-center flex-1 py-2 min-w-0">
            <h2 className="text-2xl xl:text-3xl font-light mb-3 leading-tight line-clamp-3 group-hover:text-primary transition-colors duration-200">
              {item.title}
            </h2>
            <p className="text-muted-foreground text-sm leading-relaxed line-clamp-4">
              {item.content}
            </p>
          </div>
          <div className="relative w-72 xl:w-80 shrink-0 h-full overflow-hidden rounded-2xl">
            <img
              className="object-cover w-full h-full group-hover:scale-105 transition-transform duration-500"
              src={item.thumbnail}
              alt={item.title}
              loading="lazy"
            />
          </div>
        </>
      )}
    </a>
  )
}

function SmallCard({ item }: { item: DiscoverArticle }) {
  return (
    <a
      href={articleLink(item.url)}
      className="rounded-2xl overflow-hidden bg-card border border-border/50 shadow-sm group flex flex-col"
    >
      <div className="relative aspect-video overflow-hidden">
        <img
          className="object-cover w-full h-full group-hover:scale-105 transition-transform duration-300"
          src={item.thumbnail}
          alt={item.title}
          loading="lazy"
        />
      </div>
      <div className="p-4 flex flex-col gap-1.5 flex-1">
        <h3 className="font-semibold text-sm leading-snug line-clamp-2 group-hover:text-primary transition-colors duration-200">
          {item.title}
        </h3>
        <p className="text-muted-foreground text-xs leading-relaxed line-clamp-2">
          {item.content}
        </p>
      </div>
    </a>
  )
}

function Divider() {
  return <hr className="border-t border-border/30 my-3 w-full" />
}

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center min-h-[40vh]">
      <svg
        aria-hidden="true"
        className="w-8 h-8 text-muted-foreground/30 fill-muted-foreground animate-spin"
        viewBox="0 0 100 101"
        fill="none"
      >
        <path
          d="M100 50.5908C100.003 78.2051 78.1951 100.003 50.5908 100C22.9765 99.9972 0.997224 78.018 1 50.4037C1.00281 22.7993 22.8108 0.997224 50.4251 1C78.0395 1.00281 100.018 22.8108 100 50.4251ZM9.08164 50.594C9.06312 73.3997 27.7909 92.1272 50.5966 92.1457C73.4023 92.1642 92.1298 73.4365 92.1483 50.6308C92.1669 27.8251 73.4392 9.0973 50.6335 9.07878C27.8278 9.06026 9.10003 27.787 9.08164 50.594Z"
          fill="currentColor"
        />
        <path
          d="M93.9676 39.0409C96.393 38.4037 97.8624 35.9116 96.9801 33.5533C95.1945 28.8227 92.871 24.3692 90.0681 20.348C85.6237 14.1775 79.4473 9.36872 72.0454 6.45794C64.6435 3.54717 56.3134 2.65431 48.3133 3.89319C45.869 4.27179 44.3768 6.77534 45.014 9.20079C45.6512 11.6262 48.1343 13.0956 50.5786 12.717C56.5073 11.8281 62.5542 12.5399 68.0406 14.7911C73.527 17.0422 78.2187 20.7487 81.5841 25.4923C83.7976 28.5886 85.4467 32.059 86.4416 35.7474C87.1273 38.1189 89.5423 39.6781 91.9676 39.0409Z"
          fill="currentFill"
        />
      </svg>
    </div>
  )
}

function DiscoverLayout({ articles }: { articles: DiscoverArticle[] }) {
  if (articles.length === 0) {
    return (
      <p className="text-center text-muted-foreground py-20">
        No articles found for this topic.
      </p>
    )
  }

  // Mobile: simple 2-column small card grid
  // Desktop: alternating MajorCard / 3×SmallCard sections (Vane pattern)
  const sections: React.ReactNode[] = []
  let idx = 0
  let imageLeft = false

  while (idx < articles.length) {
    if (sections.length > 0) {
      sections.push(<Divider key={`d-${idx}`} />)
    }

    // MajorCard
    if (idx < articles.length) {
      sections.push(
        <MajorCard key={`major-${idx}`} item={articles[idx]} imageLeft={imageLeft} />
      )
      imageLeft = !imageLeft
      idx++
    }

    if (idx >= articles.length) break
    sections.push(<Divider key={`d2-${idx}`} />)

    // 3 SmallCards
    const small = articles.slice(idx, idx + 3)
    sections.push(
      <div key={`small-${idx}`} className="grid lg:grid-cols-3 sm:grid-cols-2 grid-cols-1 gap-4">
        {small.map((item, i) => (
          <SmallCard key={`sc-${idx + i}`} item={item} />
        ))}
      </div>
    )
    idx += small.length
  }

  return (
    <>
      {/* Mobile: 2-col small grid */}
      <div className="block lg:hidden">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {articles.map((item, i) => (
            <SmallCard key={`m-${i}`} item={item} />
          ))}
        </div>
      </div>

      {/* Desktop: alternating layout */}
      <div className="hidden lg:block">
        {sections}
      </div>
    </>
  )
}

export default function DiscoverPage() {
  const [activeTopic, setActiveTopic] = useState(TOPICS[0].key)
  const [articles, setArticles] = useState<DiscoverArticle[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    setArticles([])
    fetch(`/api/discover?topic=${activeTopic}`)
      .then(r => r.json())
      .then(data => {
        setArticles(data.articles ?? [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [activeTopic])

  return (
    <div className="max-w-5xl mx-auto px-4">
      {/* Header */}
      <div className="flex flex-col pt-10 border-b border-border/20 pb-6 px-2">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex items-center gap-3">
            <IconWorld size={40} className="mb-1" />
            <h1 className="text-5xl font-light">Discover</h1>
          </div>
          <div className="flex flex-row items-center gap-2 overflow-x-auto pb-1">
            {TOPICS.map(t => (
              <button
                key={t.key}
                onClick={() => setActiveTopic(t.key)}
                className={cn(
                  'border rounded-full text-sm px-3 py-1 text-nowrap transition-all duration-200 cursor-pointer',
                  activeTopic === t.key
                    ? 'bg-primary/15 text-primary border-primary/50'
                    : 'border-border/50 text-muted-foreground hover:text-foreground hover:border-border hover:bg-muted/30'
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="pt-5 pb-16 lg:pb-8">
        {loading ? <LoadingSpinner /> : <DiscoverLayout articles={articles} />}
      </div>
    </div>
  )
}
