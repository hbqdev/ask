import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => selectors(m[1]).includes(selector))
    .map(m =>
      Object.fromEntries(
        m[2]
          .split(';')
          .map(d => d.split(':'))
          .filter(parts => parts.length > 1)
          .map(([prop, ...value]) => [prop.trim(), value.join(':').trim()])
      )
    )
}

/** The one rule for this selector. */
function rule(selector: string): Record<string, string> {
  const rules = declarations(selector)
  expect(rules, selector).toHaveLength(1)
  return rules[0]
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
