'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

/**
 * Auto-cycling hero headline. Rotates through a set of phrases and shuffles the
 * entrance animation on every cycle (and on each page load), so the homepage
 * greets the visitor a little differently every time.
 *
 * Ported faithfully from the finalized `ask-headlines` design study — the
 * keyframes/timings live in app/globals.css under the `ah-*` namespace; this
 * component drives the phrase/style state and re-triggers the entrance by
 * remounting the animated nodes (a changing `key`).
 */

// pre = leading text (with its trailing space where needed); accent = the
// gradient word; post = trailing punctuation. The accent isn't always the 2nd
// word, so the headline is built from these three pieces, never hardcoded.
type Phrase = { pre: string; accent: string; post: string }

const PHRASES: Phrase[] = [
  { pre: 'Ask ', accent: 'anything', post: '.' },
  { pre: 'Ask ', accent: 'everything', post: '.' },
  { pre: 'Ask ', accent: 'away', post: '.' },
  { pre: 'Ask ', accent: 'deeper', post: '.' },
  { pre: 'Ask ', accent: 'boldly', post: '.' },
  { pre: 'Ask ', accent: 'freely', post: '.' },
  { pre: 'Ask ', accent: 'better', post: '.' },
  { pre: 'Ask ', accent: 'more', post: '.' },
  { pre: 'What do you want to ', accent: 'know', post: '?' },
  { pre: 'Curious about ', accent: 'anything', post: '?' },
  { pre: 'Your questions, ', accent: 'answered', post: '.' },
  { pre: 'Wonder ', accent: 'freely', post: '.' }
]

const STYLES = ['rise', 'stagger', 'swap', 'letters'] as const
type Style = (typeof STYLES)[number]

const CYCLE_MS = 5000

/** Any index but the excluded one, so a word/phrase never repeats back to back. */
function pickIndex(length: number, exclude: number | null): number {
  const pool: number[] = []
  for (let i = 0; i < length; i++) {
    if (exclude === null || i !== exclude) pool.push(i)
  }
  return pool[Math.floor(Math.random() * pool.length)]
}

function pickStyle(exclude: Style | null): Style {
  const pool = STYLES.filter(s => exclude === null || s !== exclude)
  return pool[Math.floor(Math.random() * pool.length)]
}

/** The gradient + shimmer accent word (styling lives on `.ah-accent`). */
function Accent({ text }: { text: string }) {
  return <span className="ah-accent">{text}</span>
}

/** Build the headline body for a phrase + style — mirrors the study's build(). */
function renderPhrase(phrase: Phrase, style: Style) {
  const { pre, accent, post } = phrase

  if (style === 'letters') {
    // Cascade only the accent word's letters; pre/post fade as whole spans.
    return (
      <>
        <span className="ah-pre">{pre}</span>
        {Array.from(accent).map((ch, i) => (
          <span
            key={i}
            className="ah-l"
            style={{ animationDelay: `${(i * 0.045).toFixed(3)}s` }}
          >
            <span className="ah-accent">{ch}</span>
          </span>
        ))}
        <span className="ah-post">{post}</span>
      </>
    )
  }

  if (style === 'stagger') {
    // Each pre word rises in sequence; accent+punct arrive as one final unit.
    const preWords = pre.trim().split(/\s+/).filter(Boolean)
    const units = preWords.map((w, i) => (
      <span
        key={`w${i}`}
        className="ah-w"
        style={{ animationDelay: `${(i * 0.11).toFixed(2)}s` }}
      >
        {w}
      </span>
    ))
    units.push(
      <span
        key="accent"
        className="ah-w"
        style={{ animationDelay: `${(preWords.length * 0.11).toFixed(2)}s` }}
      >
        <Accent text={accent} />
        {post}
      </span>
    )
    // Keep the inter-word spaces as real whitespace between the inline-blocks.
    return units.map((unit, i) => (
      <Fragment key={i}>
        {i > 0 ? ' ' : null}
        {unit}
      </Fragment>
    ))
  }

  if (style === 'swap') {
    // "pre" fades, the accent word rolls in on its own axis.
    return (
      <>
        <span className="ah-pre">{pre}</span>
        <span className="ah-acc-wrap">
          <Accent text={accent} />
        </span>
        <span className="ah-post">{post}</span>
      </>
    )
  }

  // rise: the whole line lifts + de-blurs as one unit.
  return (
    <span className="ah-line">
      <span className="ah-pre">{pre}</span>
      <Accent text={accent} />
      <span className="ah-post">{post}</span>
    </span>
  )
}

export function AskHeadline({ className }: { className?: string }) {
  // Deterministic on the first render so the server HTML and the client agree
  // (this is index 0 — "Ask anything." — matching the previous static hero).
  // The random per-load pick happens in the mount effect, after hydration.
  const [phraseIdx, setPhraseIdx] = useState(0)
  const [style, setStyle] = useState<Style>('rise')
  // Bumped on every change; used as the animated node's `key` so React remounts
  // it and the CSS entrance animation replays from the top each cycle.
  const [cycle, setCycle] = useState(0)

  // firstLoad allows the very first pick to land on any phrase/style (including
  // the initial ones); subsequent ticks exclude the current to avoid repeats.
  const advance = useCallback((firstLoad: boolean) => {
    setPhraseIdx(prev => pickIndex(PHRASES.length, firstLoad ? null : prev))
    setStyle(prev => pickStyle(firstLoad ? null : prev))
    setCycle(c => c + 1)
  }, [])

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // Per-load variety: shuffle to a random phrase + style once on mount.
    // Deferred to the next frame so it isn't a synchronous setState in the
    // effect body (which cascades renders); imperceptible because every
    // entrance animation begins from opacity 0.
    const raf = requestAnimationFrame(() => advance(true))

    // Reduced motion: no auto-cycle (and globals.css strips all entrance/shimmer
    // motion) — the visitor gets a single static phrase.
    if (reduce) {
      return () => cancelAnimationFrame(raf)
    }

    const id = setInterval(() => advance(false), CYCLE_MS)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(id)
    }
  }, [advance])

  const phrase = PHRASES[phraseIdx]

  return (
    <h1
      // Stable label so screen readers announce the headline once, not every
      // ~5s as the visual word rotates.
      aria-label="Ask anything"
      className={cn(
        'font-instrument-serif text-balance text-center text-[clamp(44px,6.4vw,82px)] font-normal leading-[0.98] tracking-[-0.01em] text-foreground [perspective:800px] [word-spacing:0.1em]',
        `ah-${style}`,
        className
      )}
    >
      {/* aria-hidden + a changing key: the animated copy is decorative (the h1
          carries the accessible name) and remounts each cycle to replay the
          entrance. `contents` keeps the pieces as direct children of the h1 so
          the h1's perspective/word-spacing apply unchanged. */}
      <span key={cycle} aria-hidden="true" className="contents">
        {renderPhrase(phrase, style)}
      </span>
    </h1>
  )
}
