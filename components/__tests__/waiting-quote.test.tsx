import { act, cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_QUOTES } from '@/lib/quotes/fallback-quotes'
import { quoteTiming } from '@/lib/quotes/quote-timing'
import type { Quote } from '@/lib/quotes/types'

import { WaitingQuote } from '../waiting-quote'

const SAGAN: Quote = { q: 'We are made of star-stuff.', a: 'Carl Sagan' }

/**
 * 25 words, so the timing function tightens the cadence to 6000/25 = 240ms.
 * A quote of five words lands on exactly the 300ms default, which cannot tell
 * a derived cadence apart from a hardcoded one.
 */
const LONG_QUOTE: Quote = {
  q: Array.from({ length: 25 }, (_, i) => `word${i + 1}`).join(' '),
  a: 'Nobody'
}

function mockQuotes(quotes: Quote[]) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ quotes })
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Fake-timer advance that lets React flush the resulting state updates. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Only the spans carrying real text — the separators are spans too. */
function wordSpans(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.wq-word')).filter(
    span => /\S/.test(span.textContent ?? '')
  )
}

function quoteText(container: HTMLElement): string {
  return (
    container.querySelector('[data-testid="waiting-quote"]')?.textContent ?? ''
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  mockQuotes([SAGAN])
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('WaitingQuote', () => {
  it('renders one span per word so each can animate independently', async () => {
    const { container } = render(<WaitingQuote />)
    await advance(0)

    const words = wordSpans(container)
    // Five words plus the attribution, each independently animatable.
    expect(words).toHaveLength(6)
    expect(words.slice(0, 5).map(w => w.textContent)).toEqual([
      'We',
      'are',
      'made',
      'of',
      'star-stuff.'
    ])
    expect(words[5].textContent).toContain('Carl Sagan')
  })

  it('staggers each word by the cadence from the timing function', async () => {
    const { container } = render(<WaitingQuote />)
    await advance(0)

    const words = wordSpans(container)
    expect(words[0].style.animationDelay).toBe('0ms')
    expect(words[1].style.animationDelay).toBe('300ms')
    expect(words[2].style.animationDelay).toBe('600ms')
  })

  it('takes the cadence from the quote, not from a fixed 300ms', async () => {
    mockQuotes([LONG_QUOTE])
    const { container } = render(<WaitingQuote />)
    await advance(0)

    const words = wordSpans(container)
    expect(words[0].textContent).toBe('word1')
    // 25 words tightens the cadence to 6000/25.
    expect(words[1].style.animationDelay).toBe('240ms')
    expect(words[1].style.animationDelay).not.toBe('300ms')
    expect(words[2].style.animationDelay).toBe('480ms')
  })

  it('holds the attribution back until after the last word', async () => {
    const { container } = render(<WaitingQuote />)
    await advance(0)

    const words = wordSpans(container)
    const author = words[words.length - 1]
    // Five words at 300ms, then the author delay on top.
    expect(author.style.animationDelay).toBe('1650ms')
  })

  it('never uses the same reveal style twice running', async () => {
    // Always taking the first choice is what a picker without the
    // just-used exclusion would do — it would repeat one style forever.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const pool = [SAGAN, FALLBACK_QUOTES[1], FALLBACK_QUOTES[2]]
    mockQuotes(pool)

    const { container } = render(<WaitingQuote />)
    await advance(0)

    const seen: string[] = []
    const read = () =>
      container
        .querySelector('[data-testid="waiting-quote"]')!
        .className.split(/\s+/)
        .find(c => c.startsWith('wq-') && c !== 'wq-leaving')!

    seen.push(read())
    for (let i = 0; i < 5; i++) {
      await advance(quoteTiming(pool[i % pool.length].q).totalMs)
      seen.push(read())
    }

    expect(seen).toHaveLength(6)
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).not.toBe(seen[i - 1])
    }
    expect(new Set(seen).size).toBeGreaterThan(1)
  })

  it('rotates through the whole batch and wraps, whatever its length', async () => {
    const pool = [SAGAN, FALLBACK_QUOTES[1], FALLBACK_QUOTES[2]]
    mockQuotes(pool)

    const { container } = render(<WaitingQuote />)
    await advance(0)

    expect(quoteText(container)).toContain(pool[0].q)
    await advance(quoteTiming(pool[0].q).totalMs)
    expect(quoteText(container)).toContain(pool[1].q)
    await advance(quoteTiming(pool[1].q).totalMs)
    expect(quoteText(container)).toContain(pool[2].q)
    // Wraps back round rather than running off the end of a 40-long batch.
    await advance(quoteTiming(pool[2].q).totalMs)
    expect(quoteText(container)).toContain(pool[0].q)
  })

  it('fades the line out before replacing it', async () => {
    const { container } = render(<WaitingQuote />)
    await advance(0)

    const line = () => container.querySelector('[data-testid="waiting-quote"]')!
    const { totalMs } = quoteTiming(SAGAN.q)

    expect(line().className).not.toContain('wq-leaving')
    await advance(totalMs - 420)
    expect(line().className).toContain('wq-leaving')
    // The replacement arrives with a clean slate.
    await advance(420)
    expect(line().className).not.toContain('wq-leaving')
  })

  it('fetches exactly one batch and never goes back to the network', async () => {
    const fetchMock = mockQuotes([SAGAN])
    render(<WaitingQuote />)
    await advance(0)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/quotes?n=40')

    await advance(120_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the bundled quotes when the fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )

    const { container } = render(<WaitingQuote />)
    await advance(0)

    expect(quoteText(container)).toContain(FALLBACK_QUOTES[0].q)
    expect(container.textContent).not.toMatch(/error/i)
  })

  it('keeps the bundled quotes when the route answers with a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    )

    const { container } = render(<WaitingQuote />)
    await advance(0)

    expect(quoteText(container)).toContain(FALLBACK_QUOTES[0].q)
  })

  it('keeps the bundled quotes when the route answers with an empty batch', async () => {
    mockQuotes([])

    const { container } = render(<WaitingQuote />)
    await advance(0)

    expect(quoteText(container)).toContain(FALLBACK_QUOTES[0].q)
  })

  it('shows an elapsed timer that ticks', async () => {
    render(<WaitingQuote />)
    await advance(0)
    expect(screen.getByTestId('waiting-elapsed').textContent).toBe('0:00')

    await advance(9_000)
    expect(screen.getByTestId('waiting-elapsed').textContent).toBe('0:09')

    await advance(53_000)
    expect(screen.getByTestId('waiting-elapsed').textContent).toBe('1:02')
  })

  it('announces each quote once and keeps the timer out of the buffer', async () => {
    const { container } = render(<WaitingQuote />)
    await advance(0)

    const line = container.querySelector('[data-testid="waiting-quote"]')!
    expect(line.getAttribute('aria-live')).toBe('polite')
    expect(
      screen.getByTestId('waiting-elapsed').getAttribute('aria-hidden')
    ).toBe('true')
  })

  it('stops all timers on unmount', async () => {
    const { unmount } = render(<WaitingQuote />)
    await advance(0)

    // Guard against a vacuous pass: there must be something to clear.
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops the per-word reveal entirely under prefers-reduced-motion', () => {
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8')
    const wqReduced =
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*([^{}]*\.wq-word[^{}]*)\{([^}]*)\}/.exec(
        css
      )

    expect(wqReduced).not.toBeNull()
    const [, selectors, declarations] = wqReduced!
    expect(selectors).toContain('.wq-leaving')
    expect(declarations).toContain('animation: none !important')
    expect(declarations).toContain('opacity: 1 !important')
  })
})
