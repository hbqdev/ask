import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// The web view runs edge to edge (ios/App/App/MainViewController.swift), so
// the page clears the status bar, the rounded corners and the home indicator
// itself with env(safe-area-inset-*). These pin the rules that do it.
const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

/** A selector list's selectors: split at its commas, but not those in :is(). */
function selectors(list: string): string[] {
  const out = ['']
  let depth = 0
  for (const ch of list) {
    if (ch === ',' && depth === 0) {
      out.push('')
      continue
    }
    if (ch === '(') depth++
    if (ch === ')') depth--
    out[out.length - 1] += ch
  }
  return out.map(s => s.trim().replace(/\s+/g, ' '))
}

/** Every rule's declarations for exactly this selector (media rules too). */
function declarations(selector: string): Record<string, string>[] {
  return (
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      // The prelude starts after any statement before it (an @import).
      .filter(m => selectors(m[1].split(';').at(-1)!).includes(selector))
      .map(m =>
        Object.fromEntries(
          m[2]
            .split(';')
            .map(d => d.split(':'))
            .filter(parts => parts.length > 1)
            .map(([prop, ...value]) => [prop.trim(), value.join(':').trim()])
        )
      )
  )
}

/** The one rule for this selector. */
function rule(selector: string): Record<string, string> {
  const rules = declarations(selector)
  expect(rules, selector).toHaveLength(1)
  return rules[0]
}

/** Every app source file (not tests) under src/. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(tsx?|css)$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [path]
      : []
  })
}

/** Every match of `pattern` in the app's sources, as "file: match". */
function sourceMatches(pattern: RegExp): string[] {
  return sources(__dirname).flatMap(path =>
    [...readFileSync(path, 'utf8').matchAll(pattern)].map(
      m => `${path.slice(__dirname.length + 1)}: ${m[0]}`
    )
  )
}

describe('safe areas', () => {
  it('.app-root pads top, left and right with env(safe-area-inset-*)', () => {
    const root = rule('.app-root')
    expect(root['padding-top']).toBe('env(safe-area-inset-top)')
    expect(root['padding-left']).toBe('env(safe-area-inset-left)')
    expect(root['padding-right']).toBe('env(safe-area-inset-right)')
    // The bottom belongs to what sits there: the tab bar, a composer, or a
    // screen's own scroller (.safe-bottom), so its colour runs to the edge.
    expect(root).not.toHaveProperty('padding-bottom')
    expect(root).not.toHaveProperty('padding')
  })

  it('a .safe-bottom rule pads the bottom', () => {
    expect(rule('.safe-bottom')['padding-bottom']).toBe(
      'env(safe-area-inset-bottom)'
    )
  })

  it('keeps the tab bar, composer and sheet bottom rules', () => {
    expect(rule('.tab-bar')['padding-bottom']).toBe(
      'max(8px, env(safe-area-inset-bottom))'
    )
    expect(rule('.composer')['padding-bottom']).toBe(
      'max(env(safe-area-inset-bottom), 8px)'
    )
    expect(declarations('.sheet-panel')).toContainEqual({
      'padding-bottom': 'max(16px, env(safe-area-inset-bottom))'
    })
  })

  it('a composer in a tab sits on the tab bar without its own inset', () => {
    // Ask's home composer is above the tab bar, which already clears the
    // home indicator; only a thread's composer is at the bottom edge.
    expect(rule("[role='tabpanel'] .composer")['padding-bottom']).toBe('8px')
  })
})

describe('selection and zoom', () => {
  it('the page never zooms, and its chrome is not selectable or long-pressable', () => {
    for (const selector of ['html', 'body']) {
      const page = rule(selector)
      // Panning only: no pinch or double-tap zoom anywhere on the page.
      expect(page['touch-action'], selector).toBe('pan-x pan-y')
      expect(page['-webkit-user-select'], selector).toBe('none')
      expect(page['user-select'], selector).toBe('none')
      expect(page['-webkit-touch-callout'], selector).toBe('none')
    }
  })

  it('text people read or type stays selectable, with the callout', () => {
    const text = rule(
      ':is(.selectable, .answer-prose, input, textarea, [contenteditable])'
    )
    expect(text['-webkit-user-select']).toBe('text')
    expect(text['user-select']).toBe('text')
    expect(text['-webkit-touch-callout']).toBe('default')
  })

  it('a long press on the image viewer’s image offers to save it', () => {
    expect(rule('.image-viewer img')['-webkit-touch-callout']).toBe('default')
  })
})

describe('Dynamic Type', () => {
  it('@theme fixes the spacing step at 4px, so only type follows the text size', () => {
    // src/core/text-size.ts moves the root font size with the iOS text size;
    // a px step keeps padding, sizes and hit areas where they are (and equal
    // to Tailwind's 0.25rem default at the 16px default root).
    expect(rule('@theme')['--spacing']).toBe('4px')
  })
})

describe('Dynamic Type: line heights', () => {
  it('no leading-<n> class: with a 4px spacing step it is a fixed px line height under scaling text', () => {
    // leading-N compiles to calc(var(--spacing) * N). Use the text size's own
    // line height, leading-none/tight/snug/normal/relaxed, or a rem value.
    expect(sourceMatches(/\bleading-\d+(?:\.\d+)?\b/g)).toEqual([])
  })
})

describe('colour tokens', () => {
  /** Every declaration of the rules for this selector, merged. */
  const merged = (selector: string) =>
    Object.assign({}, ...declarations(selector))

  // [token, light, dark]
  const TOKENS = [
    // 4.81:1 on the light page (#fcfcfc): AA for text, where the mark's
    // #3694f2 is 3.06:1. Dark keeps the mark's blue (6.55:1).
    ['--accent', '#1f6fd1', 'var(--mark-blue)'],
    ['--destructive', '#c10007', '#ff6467'],
    // The chosen segment of a segmented control.
    ['--thumb', 'oklch(1 0 0)', 'oklch(0.3 0.02 289)'],
    // Sheets: the page in light, a raised surface in dark.
    ['--elevated', 'var(--background)', 'oklch(0.18 0.02 289)']
  ] as const

  it.each(TOKENS)('%s is %s in light', (token, light) => {
    expect(merged(':root')[token]).toBe(light)
  })

  it.each(TOKENS)(
    '%s is the dark value in both dark blocks (the class and the device setting)',
    (token, _light, dark) => {
      expect(rule(':root.dark')[token]).toBe(dark)
      expect(rule(':root:not(.light)')[token]).toBe(dark)
    }
  )

  it('the card tint is 5% foreground over the page, in every theme', () => {
    expect(merged(':root')['--card']).toBe(
      'color-mix(in oklch, var(--foreground) 5%, var(--background))'
    )
  })

  it('a card in a sheet tints the sheet’s own surface', () => {
    expect(declarations('.sheet-panel')).toContainEqual({
      '--card': 'color-mix(in oklch, var(--foreground) 5%, var(--elevated))'
    })
  })

  it.each(['accent', 'destructive', 'thumb', 'elevated', 'card'])(
    '@theme inline maps --color-%s to its token',
    name => {
      expect(rule('@theme inline')[`--color-${name}`]).toBe(`var(--${name})`)
    }
  )

  it('links in an answer use the accent', () => {
    const link = rule('.answer-prose .answer-link')
    expect(link.color).toBe('var(--accent)')
    expect(link['text-decoration-color']).toBe(
      'color-mix(in oklch, var(--accent) 40%, transparent)'
    )
  })
})

describe('one colour system in the sources', () => {
  it('no text-red-500/600 or text-mark-blue text classes remain', () => {
    // Text uses the AA tokens: text-destructive and text-accent. Fills
    // (bg-red-500, bg-mark-blue, fill-mark-*) stay.
    expect(sourceMatches(/\btext-red-\d+\b/g)).toEqual([])
    expect(sourceMatches(/\btext-mark-blue\b/g)).toEqual([])
  })

  it('no bare animate-pulse remains', () => {
    // Pulses honour reduced motion: motion-safe:animate-pulse.
    expect(sourceMatches(/(?<!motion-safe:)\banimate-pulse\b/g)).toEqual([])
  })
})
