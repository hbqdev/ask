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

/** The contents of the one `@media <query>` block, braces balanced. */
function mediaBlock(query: string): string {
  return atBlock(`@media ${query}`)
}

/** The contents of the one `<at>` block (an @media, an @layer), braces balanced. */
function atBlock(at: string): string {
  const start = css.indexOf(at)
  expect(start, at).toBeGreaterThanOrEqual(0)
  expect(css.indexOf(at, start + 1), `one ${at}`).toBe(-1)
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
  }
  throw new Error(`${at} is not closed`)
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

/**
 * Each finding of `check` (given a file's text) in the app's sources, as
 * "file: finding".
 */
function sourceFindings(check: (text: string) => string[]): string[] {
  return sources(__dirname).flatMap(path =>
    check(readFileSync(path, 'utf8')).map(
      found => `${path.slice(__dirname.length + 1)}: ${found}`
    )
  )
}

/**
 * The class strings in `text`: quoted strings on one line, and template
 * literals whole (so a class picked by a ternary inside counts as theirs).
 */
function classStrings(text: string): string[] {
  return [...text.matchAll(/`[^`]*`|'[^'\n]*'|"[^"\n]*"/g)].map(m => m[0])
}

// A fill white text is under 4.5:1 on, in any opacity or as an arbitrary hex.
const LOW_FILL =
  /(?:\bbg-(?:mark-blue|red-500)(?:\/\d+)?|\bbg-\[#[0-9a-f]{3,8}\])(?![\w/-])/i

/** Class strings that put white text on a fill under 4.5:1. */
function whiteOnLowFill(text: string): string[] {
  return classStrings(text).filter(
    s => LOW_FILL.test(s) && /\btext-white\b/.test(s)
  )
}

/** Class strings with text under 4.5:1 (foreground/40-50), not on an icon. */
function faintText(text: string): string[] {
  return classStrings(text).filter(
    s => /\btext-foreground\/(?:40|45|50)\b/.test(s) && !/\bsize-/.test(s)
  )
}

/** A pulse, however spelled, that does not honour reduced motion. */
const BARE_PULSE =
  /(?<!motion-safe:)\banimate-(?:pulse\b|\[pulse)|(?<!motion-safe:)\[animation:pulse|\banimation:\s*pulse\b/g

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

  it('at md (iPad) the centred card opens with a scale and fade, not a rise from below', () => {
    // A slide of 100% of a short card's own height would start it far below
    // the centre. Reduced motion keeps the plain fade for every width.
    expect(css).toMatch(
      /@keyframes sheet-pop\s*\{\s*from\s*\{\s*opacity:\s*0;\s*transform:\s*scale\(0\.96\);?\s*\}\s*to\s*\{\s*opacity:\s*1;\s*transform:\s*scale\(1\);?\s*\}\s*\}/
    )
    const pop = atBlock(
      '@media (prefers-reduced-motion: no-preference) and (min-width: 768px)'
    )
    expect(pop).toMatch(
      /\.sheet-panel\s*\{\s*animation:\s*sheet-pop var\(--nav-duration\) var\(--nav-ease\);?\s*\}/
    )
    // After the phone's slide-up, so it wins at md.
    expect(
      css.indexOf(
        '@media (prefers-reduced-motion: no-preference) and (min-width: 768px)'
      )
    ).toBeGreaterThan(css.indexOf('animation: sheet-in'))
    expect(css).toMatch(
      /\.sheet-panel,\s*\.sheet-backdrop\s*\{\s*animation:\s*stack-fade-in 200ms linear;?\s*\}/
    )
  })

  it('at md (iPad) a sheet is a floating card, padded 16 px at the bottom', () => {
    // Away from the home indicator, the card needs no inset.
    const md = mediaBlock('(min-width: 768px)')
    expect(md).toMatch(/\.sheet-panel\s*\{\s*padding-bottom:\s*16px;?\s*\}/)
    // After the phone rule, so it wins at md.
    expect(css.indexOf('@media (min-width: 768px)')).toBeGreaterThan(
      css.indexOf('max(16px, env(safe-area-inset-bottom))')
    )
  })

  it('a composer on the tab bar sits there without its own inset', () => {
    // Ask's home composer is above the tab bar, which already clears the
    // home indicator; only a thread's composer is at the bottom edge. The
    // home says so itself (onTabBar), not by an ARIA role around it.
    expect(rule('.composer.composer-on-tab-bar')['padding-bottom']).toBe('8px')
    expect(css).not.toContain("[role='tabpanel'] .composer")
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

describe('focus', () => {
  it('a heading focused by navigation draws no focus ring', () => {
    // focusHeading (core/ui/focus.ts) gives a screen's h1 tabindex -1 and
    // focuses it, for VoiceOver; it is not a control, so no ring shows.
    expect(rule("h1[tabindex='-1']:focus")).toEqual({ outline: 'none' })
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

describe('tap targets', () => {
  it('.hit-target is the box its hit area is centred on', () => {
    expect(rule('.hit-target')).toEqual({ position: 'relative' })
  })

  it('.hit-target::after is a hit area at least 44 px each way, centred on the control', () => {
    expect(rule('.hit-target::after')).toEqual({
      content: "''",
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: 'max(100%, 44px)',
      height: 'max(100%, 44px)',
      transform: 'translate(-50%, -50%)'
    })
  })

  it('a citation chip’s hit area is one line of the answer tall, so the lines above and below keep theirs', () => {
    // Inline in the text (WCAG 2.5.8's inline exception): a 44 px area would
    // reach 12 px into the next line and, painted later, take taps on the
    // chip or link there. One line of the answer: its font size × its
    // line height.
    const prose = rule('.answer-prose')
    expect(prose['font-size']).toBe('1rem')
    expect(prose['line-height']).toBe('1.65')
    expect(rule('.answer-prose .citation-chip.hit-target::after')).toEqual({
      height: 'min(44px, 1.65rem)'
    })
  })

  it('.hit-target sits in @layer components, so a positioning utility on the control wins', () => {
    // Unlayered, its position: relative would beat Tailwind's layered
    // absolute / fixed / sticky on the same control; in the components layer
    // the utility wins, and those are containing blocks for the area too.
    const layer = atBlock('@layer components')
    expect(layer).toMatch(
      /(^|\})\s*\.hit-target\s*\{\s*position:\s*relative;?\s*\}/
    )
    expect(layer).toMatch(/\.hit-target::after\s*\{/)
    // The chip's cap stays unlayered, so it beats the area's height.
    expect(layer).not.toContain('citation-chip')
  })

  it('no .hit-target control draws its own ::after, constants included (an after: utility would move its area)', () => {
    const constants = classConstants()
    expect(constants.get('SEPARATOR')).toContain('after:')
    expect(sourceFindings(text => hitTargetWithAfter(text, constants))).toEqual(
      []
    )
  })

  it('the ::after scan sees through class constants', () => {
    const constants = new Map([
      ['SEP', 'after:absolute after:h-px'],
      ['ROUND', 'size-9 rounded-full']
    ])
    expect(
      hitTargetWithAfter(`'hit-target after:left-4'`, constants)
    ).toHaveLength(1)
    expect(hitTargetWithAfter('`hit-target ${SEP}`', constants)).toHaveLength(1)
    expect(hitTargetWithAfter('`${ROUND} hit-target`', constants)).toEqual([])
    expect(hitTargetWithAfter(`'hit-target size-9'`, constants)).toEqual([])
  })
})

/** The string constants (NAME = '…') the app's sources define. */
function classConstants(): Map<string, string> {
  return new Map(
    sources(__dirname).flatMap(path =>
      [
        ...readFileSync(path, 'utf8').matchAll(
          /\bconst ([A-Z][A-Z0-9_]*)\s*=\s*(['"`])([^'"`]*)\2/g
        )
      ].map(m => [m[1], m[3]] as [string, string])
    )
  )
}

/**
 * Class strings with hit-target and an after: utility, a ${CONSTANT} in a
 * template literal read as its value.
 */
function hitTargetWithAfter(
  text: string,
  constants: Map<string, string>
): string[] {
  return classStrings(text)
    .map(s =>
      s.replace(
        /\$\{([A-Z][A-Z0-9_]*)\}/g,
        (all, name: string) => constants.get(name) ?? all
      )
    )
    .filter(s => /\bhit-target\b/.test(s) && /\bafter:/.test(s))
}

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
    ['--elevated', 'var(--background)', 'oklch(0.18 0.02 289)'],
    // A grouped card: about iOS's secondary grouped background. Plain values
    // (no color-mix), so the build adds no solid-colour fallback.
    ['--card', 'oklch(0.94 0 0)', 'oklch(0.21 0.02 289)'],
    // A fill under white text: 4.94:1 in both themes (the mark's blue is
    // 3.15:1 under white).
    ['--accent-fill', '#1f6fd1', '#1f6fd1'],
    // A sheet's own card, muted surface and thumb: the page's in light,
    // raised with the sheet in dark.
    ['--sheet-card', 'var(--card)', 'oklch(0.24 0.02 289)'],
    ['--sheet-muted', 'var(--muted)', 'oklch(0.26 0.02 289)'],
    ['--sheet-thumb', 'var(--thumb)', 'oklch(0.36 0.02 289)']
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

  it('in a sheet, cards, muted surfaces and the thumb are the sheet’s own', () => {
    expect(declarations('.sheet-panel')).toContainEqual({
      '--card': 'var(--sheet-card)',
      '--muted': 'var(--sheet-muted)',
      '--thumb': 'var(--sheet-thumb)'
    })
  })

  it('dark surfaces step up clearly: page < card, muted < thumb; in a sheet, elevated < card, muted < thumb', () => {
    const dark = rule(':root.dark')
    /** The lightness of a dark token's oklch value. */
    const L = (token: string) =>
      Number(/^oklch\(([\d.]+)/.exec(dark[token])![1])
    // A card reads against the page (iOS: #1c1c1e on black).
    expect(L('--card') - L('--background')).toBeGreaterThanOrEqual(0.1)
    expect(L('--thumb')).toBeGreaterThan(L('--muted'))
    // In a sheet, each surface sits above the raised panel, not below it.
    expect(L('--sheet-card') - L('--elevated')).toBeGreaterThanOrEqual(0.05)
    expect(L('--sheet-muted') - L('--elevated')).toBeGreaterThanOrEqual(0.08)
    expect(L('--sheet-thumb') - L('--sheet-muted')).toBeGreaterThanOrEqual(0.08)
  })

  it.each([
    'accent',
    'destructive',
    'thumb',
    'elevated',
    'card',
    'accent-fill'
  ])('@theme inline maps --color-%s to its token', name => {
    expect(rule('@theme inline')[`--color-${name}`]).toBe(`var(--${name})`)
  })

  it('links in an answer use the accent', () => {
    const link = rule('.answer-prose .answer-link')
    expect(link.color).toBe('var(--accent)')
    expect(link['text-decoration-color']).toBe(
      'color-mix(in oklch, var(--accent) 40%, transparent)'
    )
  })
})

describe('one colour system in the sources', () => {
  it('scans the app’s sources (not an empty list)', () => {
    expect(sources(__dirname).length).toBeGreaterThan(50)
  })

  it('no white text on a fill under 4.5:1 (bg-mark-blue, bg-red-500)', () => {
    // Use bg-accent-fill (4.94:1) and bg-red-600 (4.76:1).
    expect(sourceFindings(whiteOnLowFill)).toEqual([])
  })

  it('the white-on-fill scan catches every spelling, and passes the AA fills', () => {
    for (const bad of [
      `'bg-red-500 text-white'`,
      `"text-white px-2 bg-mark-blue"`,
      '`rounded bg-red-500/90 text-white`',
      "`px-2 ${on ? 'bg-red-500' : 'bg-muted'} text-white`",
      "`${on ? 'text-white' : ''} p-1 bg-[#3694f2]`"
    ]) {
      expect(whiteOnLowFill(bad)).toHaveLength(1)
    }
    for (const good of [
      `'bg-red-600 text-white'`,
      `'bg-accent-fill text-white'`,
      `'bg-red-500/10 text-destructive'`,
      `'size-2 rounded-full bg-red-500'`,
      `'bg-mark-blue'`
    ]) {
      expect(whiteOnLowFill(good)).toEqual([])
    }
  })

  it('no faint text: placeholders and notes are at least 4.5:1', () => {
    // placeholder:text-foreground/40 is 2.80:1 and text-foreground/50 is
    // 3.95:1 on the light page: use placeholder:text-muted-foreground and
    // text-foreground/60 (5.69:1). Lower opacities stay for icons only (a
    // sized svg or icon box: non-text, 3:1).
    expect(sourceMatches(/\bplaceholder:text-foreground\/\d+/g)).toEqual([])
    expect(sourceFindings(faintText)).toEqual([])
  })

  it('the faint-text scan catches /40, /45 and /50 on text, not on icons', () => {
    for (const bad of [
      `'text-sm text-foreground/40'`,
      `"text-foreground/45"`,
      '`mt-1 ${x} text-foreground/50`'
    ]) {
      expect(faintText(bad)).toHaveLength(1)
    }
    for (const good of [
      `'size-5 shrink-0 text-foreground/40'`,
      `'text-sm text-foreground/60'`,
      `'text-foreground/20 size-full'`
    ]) {
      expect(faintText(good)).toEqual([])
    }
  })

  it('no text-red-500/600 or text-mark-blue text classes remain', () => {
    // Text uses the AA tokens: text-destructive and text-accent. Fills
    // (bg-red-500, bg-mark-blue, fill-mark-*) stay.
    expect(sourceMatches(/\btext-red-\d+\b/g)).toEqual([])
    expect(sourceMatches(/\btext-mark-blue\b/g)).toEqual([])
  })

  it('no bare animate-pulse remains', () => {
    // Pulses honour reduced motion: motion-safe:animate-pulse.
    expect(sourceMatches(BARE_PULSE)).toEqual([])
  })

  it('the pulse scan catches every spelling without motion-safe:', () => {
    for (const bad of [
      'animate-pulse',
      'animate-[pulse_2s_infinite]',
      '[animation:pulse_1s]',
      'animation: pulse 2s'
    ]) {
      expect(bad.match(BARE_PULSE)).toHaveLength(1)
    }
    for (const good of [
      'motion-safe:animate-pulse',
      'motion-safe:animate-[pulse_2s_infinite]',
      'motion-safe:[animation:pulse_1s]'
    ]) {
      expect(good.match(BARE_PULSE)).toBeNull()
    }
  })
})
