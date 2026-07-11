'use client'

import { useEffect, useState } from 'react'

import { IconWorld } from '@tabler/icons-react'
import { toast } from 'sonner'

import { SUMMARIZE_LABEL } from '@/lib/constants'
import { cn } from '@/lib/utils'

export interface Discover {
  title: string
  content: string
  url: string
  thumbnail: string
}

const topics: { key: string; display: string }[] = [
  { display: 'Tech & Science', key: 'tech' },
  { display: 'Finance', key: 'finance' },
  { display: 'Art & Culture', key: 'art' },
  { display: 'Sports', key: 'sports' },
  { display: 'Entertainment', key: 'entertainment' },
]

function thumbUrl(raw: string) {
  try {
    const u = new URL(raw)
    // Bing News thumbnails use ?id= as the only meaningful param — strip the rest
    if (u.hostname.includes('bing.com') && u.searchParams.has('id')) {
      return `${u.origin}${u.pathname}?id=${u.searchParams.get('id')}`
    }
    // Google News and all other engines: use URL as-is
    return raw
  } catch {
    return raw
  }
}

function SmallNewsCard({ item }: { item: Discover }) {
  return (
    <div className="relative rounded-3xl overflow-hidden bg-[#f6f8fa] dark:bg-[#161b22] shadow-sm shadow-black/10 dark:shadow-black/25 group flex flex-col">
      <a href={item.url} target="_blank" rel="noopener noreferrer" className="flex flex-col flex-1">
        <div className="relative aspect-video overflow-hidden">
          <img
            className="object-cover w-full h-full group-hover:scale-105 transition-transform duration-300"
            src={thumbUrl(item.thumbnail)}
            alt={item.title}
            loading="lazy"
          />
        </div>
        <div className="p-4 pb-2">
          <h3 className="font-semibold text-sm mb-2 leading-tight line-clamp-2 group-hover:text-cyan-500 dark:group-hover:text-cyan-300 transition duration-200">
            {item.title}
          </h3>
          <p className="text-black/60 dark:text-white/60 text-xs leading-relaxed line-clamp-2">
            {item.content}
          </p>
        </div>
      </a>
      <div className="px-4 pb-3 flex justify-end">
        <a
          href={`/?q=${encodeURIComponent(`Summary: ${item.url}`)}`}
          title={SUMMARIZE_LABEL}
          className="text-[10px] font-semibold px-2.5 py-1 rounded-full bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/25 border border-cyan-500/30"
        >
          {SUMMARIZE_LABEL}
        </a>
      </div>
    </div>
  )
}

function MajorNewsCard({ item, isLeft = true }: { item: Discover; isLeft?: boolean }) {
  const img = (
    <div className="relative w-80 h-full overflow-hidden rounded-2xl flex-shrink-0">
      <img
        className="object-cover w-full h-full group-hover:scale-105 transition-transform duration-500"
        src={thumbUrl(item.thumbnail)}
        alt={item.title}
        loading="lazy"
      />
    </div>
  )
  const text = (
    <div className="flex flex-col justify-center flex-1 py-4 min-w-0">
      <h2
        className="text-3xl font-light mb-3 leading-tight line-clamp-3 group-hover:text-cyan-500 dark:group-hover:text-cyan-300 transition duration-200"
        style={{ fontFamily: 'Georgia, serif' }}
      >
        {item.title}
      </h2>
      <p className="text-black/60 dark:text-white/60 text-base leading-relaxed line-clamp-3">
        {item.content}
      </p>
      <a
        href={`/?q=${encodeURIComponent(`Summary: ${item.url}`)}`}
        onClick={e => e.stopPropagation()}
        className="mt-3 self-start text-xs font-semibold px-3 py-1.5 rounded-full bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/25 border border-cyan-500/30"
      >
        {SUMMARIZE_LABEL}
      </a>
    </div>
  )

  return (
    <div
      className="w-full group flex flex-row items-stretch gap-6 h-60 py-3 cursor-pointer"
      onClick={() => window.open(item.url, '_blank', 'noopener,noreferrer')}
    >
      {isLeft ? <>{img}{text}</> : <>{text}{img}</>}
    </div>
  )
}

const Page = () => {
  const [discover, setDiscover] = useState<Discover[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTopic, setActiveTopic] = useState<string>(topics[0].key)

  const fetchArticles = async (topic: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/discover?topic=${topic}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.message)
      }

      data.blogs = data.blogs.filter((blog: Discover) => blog.thumbnail)
      setDiscover(data.blogs)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      console.error('Error fetching data:', msg)
      toast.error('Error fetching data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchArticles(activeTopic)
  }, [activeTopic])

  return (
    <div className="h-full overflow-y-auto bg-[#ffffff] dark:bg-[#0d1117]">
      <div className="w-full max-w-screen-lg mx-auto px-4">
        <div className="flex flex-col pt-10 border-b border-[#e8edf1] dark:border-[#21262d] pb-6 px-2">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div className="flex items-center justify-center">
              <IconWorld size={45} className="mb-2.5" />
              <h1
                className="text-5xl font-normal p-2"
                style={{ fontFamily: 'Georgia, serif' }}
              >
                Discover
              </h1>
            </div>
            <div className="flex flex-row items-center space-x-2 overflow-x-auto">
              {topics.map((t, i) => (
                <div
                  key={i}
                  className={cn(
                    'border-[0.1px] rounded-full text-sm px-3 py-1 text-nowrap transition duration-200 cursor-pointer',
                    activeTopic === t.key
                      ? 'text-cyan-700 dark:text-cyan-300 bg-cyan-300/20 border-cyan-700/60 dark:bg-cyan-300/30 dark:border-cyan-300/40'
                      : 'border-black/30 dark:border-white/30 text-black/70 dark:text-white/70 hover:text-black dark:hover:text-white hover:border-black/40 dark:hover:border-white/40 hover:bg-black/5 dark:hover:bg-white/5'
                  )}
                  onClick={() => setActiveTopic(t.key)}
                >
                  <span>{t.display}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-row items-center justify-center min-h-[60vh]">
            <svg
              aria-hidden="true"
              className="w-8 h-8 text-black/10 fill-zinc-300 dark:text-[#202020] animate-spin dark:fill-[#ffffff3b]"
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
        ) : (
          <div className="flex flex-col gap-4 pb-28 pt-5 lg:pb-8 w-full">
            {/* Mobile */}
            <div className="block lg:hidden">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {discover?.map((item, i) => (
                  <SmallNewsCard key={`mobile-${i}`} item={item} />
                ))}
              </div>
            </div>

            {/* Desktop */}
            <div className="hidden lg:block">
              {discover &&
                discover.length > 0 &&
                (() => {
                  const sections: React.ReactNode[] = []
                  let index = 0

                  while (index < discover.length) {
                    if (sections.length > 0) {
                      sections.push(
                        <hr key={`sep-${index}`} className="border-t border-[#e8edf1] dark:border-[#21262d] my-3 w-full" />
                      )
                    }

                    if (index < discover.length) {
                      sections.push(
                        <MajorNewsCard key={`major-${index}`} item={discover[index]} isLeft={false} />
                      )
                      index++
                    }

                    if (index < discover.length) {
                      sections.push(
                        <hr key={`sep-${index}-after`} className="border-t border-[#e8edf1] dark:border-[#21262d] my-3 w-full" />
                      )
                    }

                    if (index < discover.length) {
                      const smallCards = discover.slice(index, index + 3)
                      sections.push(
                        <div key={`small-group-${index}`} className="grid lg:grid-cols-3 sm:grid-cols-2 grid-cols-1 gap-4">
                          {smallCards.map((item, i) => (
                            <SmallNewsCard key={`small-${index + i}`} item={item} />
                          ))}
                        </div>
                      )
                      index += 3
                    }

                    if (index < discover.length) {
                      sections.push(
                        <hr key={`sep-${index}-after-small`} className="border-t border-[#e8edf1] dark:border-[#21262d] my-3 w-full" />
                      )
                    }

                    if (index < discover.length - 1) {
                      const twoMajorCards = discover.slice(index, index + 2)
                      twoMajorCards.forEach((item, i) => {
                        sections.push(
                          <MajorNewsCard key={`double-${index + i}`} item={item} isLeft={i === 0} />
                        )
                        if (i === 0) {
                          sections.push(
                            <hr key={`sep-double-${index + i}`} className="border-t border-[#e8edf1] dark:border-[#21262d] my-3 w-full" />
                          )
                        }
                      })
                      index += 2
                    } else if (index < discover.length) {
                      sections.push(
                        <MajorNewsCard key={`final-major-${index}`} item={discover[index]} isLeft={true} />
                      )
                      index++
                    }

                    if (index < discover.length) {
                      sections.push(
                        <hr key={`sep-${index}-after-major`} className="border-t border-[#e8edf1] dark:border-[#21262d] my-3 w-full" />
                      )
                    }

                    if (index < discover.length) {
                      const smallCards = discover.slice(index, index + 3)
                      sections.push(
                        <div key={`small-group-2-${index}`} className="grid lg:grid-cols-3 sm:grid-cols-2 grid-cols-1 gap-4">
                          {smallCards.map((item, i) => (
                            <SmallNewsCard key={`small-2-${index + i}`} item={item} />
                          ))}
                        </div>
                      )
                      index += 3
                    }
                  }

                  return sections
                })()}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default Page
