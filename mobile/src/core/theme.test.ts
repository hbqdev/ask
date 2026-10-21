import { afterEach, describe, expect, it } from 'vitest'

import {
  applyTheme,
  parseThemePref,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemePref
} from '@/core/theme'

describe('resolveTheme', () => {
  it.each<[ThemePref, boolean, 'light' | 'dark']>([
    ['system', false, 'light'],
    ['system', true, 'dark'],
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark']
  ])('%s with system dark %s resolves to %s', (pref, systemDark, expected) => {
    expect(resolveTheme(pref, systemDark)).toBe(expected)
  })
})

describe('parseThemePref', () => {
  it.each(['system', 'light', 'dark'] as const)('keeps %s', value => {
    expect(parseThemePref(value)).toBe(value)
  })

  it.each([null, '', 'Dark', 'sepia', '"dark"'])(
    'treats %j as system',
    value => {
      expect(parseThemePref(value)).toBe('system')
    }
  )
})

describe('applyTheme', () => {
  afterEach(() => {
    document.documentElement.className = ''
    document.documentElement.style.colorScheme = ''
  })

  it('dark adds the dark class and a dark color scheme', () => {
    applyTheme('dark')
    const root = document.documentElement
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.classList.contains('light')).toBe(false)
    expect(root.style.colorScheme).toBe('dark')
  })

  it('light removes the dark class and sets a light color scheme', () => {
    const root = document.documentElement
    root.classList.add('dark', 'keep-me')
    applyTheme('light')
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.classList.contains('light')).toBe(true)
    expect(root.classList.contains('keep-me')).toBe(true)
    expect(root.style.colorScheme).toBe('light')
  })

  it('applies to a given root element', () => {
    const el = document.createElement('div')
    applyTheme('dark', el)
    expect(el.classList.contains('dark')).toBe(true)
    expect(el.style.colorScheme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})

it('stores the preference under the key "theme"', () => {
  expect(THEME_STORAGE_KEY).toBe('theme')
})
