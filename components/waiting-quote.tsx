'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { FALLBACK_QUOTES } from '@/lib/quotes/fallback-quotes'
import {
  QUOTE_AUTHOR_DELAY_MS,
  QUOTE_FADE_OUT_MS,
  quoteTiming
} from '@/lib/quotes/quote-timing'
import type { Quote } from '@/lib/quotes/types'

const STYLES = [
  'wq-rise',
  'wq-focus',
  'wq-drift',
  'wq-settle',
  'wq-wipe'
] as const

/** The route caps at whatever the pool holds, so the batch may be smaller. */
const BATCH_SIZE = 40

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Any style but the one just used, so no reveal repeats back to back. */
function pickStyle(justUsed: string): string {
  const choices = STYLES.filter(s => s !== justUsed)
  return choices[Math.floor(Math.random() * choices.length)]
}

/**
 * Ambient reading material for long waits: an elapsed timer plus a quote that
 * reveals a word at a time, changing animation with every quote.
 *
 * One batch is fetched per mount and cycled locally — nothing hits the network
 * while the user is actually waiting.
 */
export function WaitingQuote() {
  const [pool, setPool] = useState<Quote[]>(FALLBACK_QUOTES)
  const [index, setIndex] = useState(0)
  // Deterministic on the first render so the server and the client agree; the
  // random pick happens in the effect, after hydration.
  const [styleClass, setStyleClass] = useState<string>(STYLES[0])
  const [leaving, setLeaving] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const previousStyle = useRef<string>('')

  // One batch per mount.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/quotes?n=${BATCH_SIZE}`)
      .then(res => (res.ok ? res.json() : null))
      .then((data: { quotes?: Quote[] } | null) => {
        if (cancelled || !data?.quotes?.length) return
        setPool(data.quotes)
        setIndex(0)
      })
      .catch(() => {
        // Keep the bundled set — a quote is decoration, not a failure worth showing.
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    // Derived from a start timestamp, NOT by counting ticks: browsers throttle
    // setInterval hard in a background tab, so an incrementing counter drifts
    // behind and under-reports exactly when a long wait makes the number worth
    // reading. Recomputing from the clock self-corrects on the next tick.
    const startedAt = Date.now()
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000
    )
    return () => clearInterval(id)
  }, [])

  // Pick a style that is not the one just used, then schedule the changeover.
  // Keyed on the index rather than the quote object: a one-entry pool hands
  // back the same object every cycle, which would stall the rotation.
  useEffect(() => {
    const current = pool.length ? pool[index % pool.length] : undefined
    if (!current) return

    const next = pickStyle(previousStyle.current)
    previousStyle.current = next
    setStyleClass(next)
    setLeaving(false)

    const { totalMs } = quoteTiming(current.q)
    const fadeAt = Math.max(0, totalMs - QUOTE_FADE_OUT_MS)
    const fadeId = setTimeout(() => setLeaving(true), fadeAt)
    const nextId = setTimeout(() => setIndex(i => i + 1), totalMs)
    return () => {
      clearTimeout(fadeId)
      clearTimeout(nextId)
    }
  }, [index, pool])

  const quote = pool.length ? pool[index % pool.length] : undefined
  const timing = useMemo(() => quoteTiming(quote?.q ?? ''), [quote?.q])

  if (!quote) return null

  // Separators are kept as their own spans (with `white-space: pre`) so the
  // spacing survives the words becoming inline-blocks.
  const tokens = quote.q.split(/(\s+)/).filter(Boolean)
  let wordIndex = 0

  return (
    <div className="mt-2 flex flex-col gap-1">
      <div
        data-testid="waiting-quote"
        className={`text-sm italic text-muted-foreground/80 ${styleClass} ${leaving ? 'wq-leaving' : ''}`}
        aria-live="polite"
      >
        {tokens.map((token, i) => {
          const delay = wordIndex * timing.perWordMs
          if (/\S/.test(token)) wordIndex++
          return (
            <span
              key={`${index}-${i}`}
              className="wq-word"
              style={{ animationDelay: `${delay}ms` }}
            >
              {token}
            </span>
          )
        })}
        <span
          key={`${index}-author`}
          className="wq-word not-italic text-xs text-muted-foreground/60"
          style={{
            animationDelay: `${wordIndex * timing.perWordMs + QUOTE_AUTHOR_DELAY_MS}ms`
          }}
        >
          {`  — ${quote.a}`}
        </span>
      </div>
      <span
        data-testid="waiting-elapsed"
        aria-hidden="true"
        className="font-mono text-xs tabular-nums text-muted-foreground/50"
      >
        {formatElapsed(elapsed)}
      </span>
    </div>
  )
}
