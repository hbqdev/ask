import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BODY_DEFAULT_PX,
  ROOT_DEFAULT_PX,
  ROOT_MAX_PX,
  ROOT_MIN_PX,
  rootFontSize,
  watchTextSize
} from '@/core/text-size'
import { resize } from '@/test/resize-observer'

describe('rootFontSize', () => {
  it('names the iOS defaults and the clamp', () => {
    expect(ROOT_DEFAULT_PX).toBe(16)
    expect(BODY_DEFAULT_PX).toBe(17)
    expect(ROOT_MIN_PX).toBe(14)
    expect(ROOT_MAX_PX).toBe(24)
  })

  it('keeps the default at 16px', () => {
    // iOS body text is 17px at the default (Large) size.
    expect(rootFontSize(17)).toBe(16)
  })

  it('floors the root at 14px', () => {
    // xSmall body is 14px: 16 × 14 / 17 = 13.18, floored.
    expect(rootFontSize(14)).toBe(14)
  })

  it('caps the root at 24px', () => {
    // The largest accessibility size (AX5) is a 53px body.
    expect(rootFontSize(53)).toBe(24)
  })

  it('scales in between, rounded to 0.01px', () => {
    // xLarge: body 19px → 16 × 19 / 17 = 17.882…
    expect(rootFontSize(19)).toBe(17.88)
  })

  it('falls back to 16px for a size it cannot read', () => {
    for (const bad of [NaN, Infinity, -Infinity, 0, -17]) {
      expect(rootFontSize(bad), String(bad)).toBe(16)
    }
  })
})

describe('watchTextSize', () => {
  /** The body size the probe's computed style reports. */
  let bodyPx: string
  let supports: ReturnType<typeof vi.fn>

  function probe() {
    return document.body.querySelector<HTMLElement>('span[aria-hidden="true"]')
  }

  beforeEach(() => {
    bodyPx = '17px'
    supports = vi.fn(
      (property: string, value: string) =>
        property === 'font' && value === '-apple-system-body'
    )
    vi.stubGlobal('CSS', { supports })
    const real = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element =>
      element === probe()
        ? ({ fontSize: bodyPx } as CSSStyleDeclaration)
        : real(element)
    )
    document.documentElement.style.fontSize = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.documentElement.style.fontSize = ''
    document.body.innerHTML = ''
  })

  it('does nothing where the system body font is not supported', () => {
    supports.mockReturnValue(false)
    const stop = watchTextSize()
    expect(probe()).toBeNull()
    expect(document.documentElement.style.fontSize).toBe('')
    expect(() => stop()).not.toThrow()
  })

  it('does nothing without CSS at all', () => {
    vi.stubGlobal('CSS', undefined)
    const stop = watchTextSize()
    expect(probe()).toBeNull()
    expect(document.documentElement.style.fontSize).toBe('')
    expect(() => stop()).not.toThrow()
  })

  it('adds a hidden probe in the system body font and applies its size', () => {
    bodyPx = '19px'
    watchTextSize()
    const span = probe()!
    expect(span).not.toBeNull()
    expect(span.textContent).toBe('M')
    // Pinned to the viewport's corner, out of the flow: it must never make
    // the document taller than the screen (the web view would scroll).
    expect(span.style.position).toBe('fixed')
    expect(span.style.top).toBe('0px')
    expect(span.style.left).toBe('0px')
    expect(span.style.pointerEvents).toBe('none')
    expect(span.style.visibility).toBe('hidden')
    expect(span.getAttribute('style')).toMatch(/font:\s*-apple-system-body/)
    expect(supports).toHaveBeenCalledWith('font', '-apple-system-body')
    expect(document.documentElement.style.fontSize).toBe('17.88px')
  })

  it('works on the document it is given', () => {
    watchTextSize(document)
    expect(document.documentElement.style.fontSize).toBe('16px')
  })

  it('re-applies when the probe resizes', () => {
    watchTextSize()
    expect(document.documentElement.style.fontSize).toBe('16px')
    bodyPx = '53px'
    resize(probe()!)
    expect(document.documentElement.style.fontSize).toBe('24px')
  })

  it('re-applies when the app comes back into view', () => {
    watchTextSize()
    bodyPx = '14px'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(document.documentElement.style.fontSize).toBe('14px')
  })

  it('writes the root size only when it changes', () => {
    watchTextSize()
    const style = document.documentElement.style
    const set = vi.spyOn(style, 'fontSize', 'set')
    resize(probe()!)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(set).not.toHaveBeenCalled()
    bodyPx = '19px'
    resize(probe()!)
    expect(set).toHaveBeenCalledExactlyOnceWith('17.88px')
  })

  it('cleanup removes the probe and stops updating', () => {
    const stop = watchTextSize()
    const span = probe()!
    stop()
    expect(probe()).toBeNull()
    bodyPx = '53px'
    resize(span)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(document.documentElement.style.fontSize).toBe('16px')
  })
})
