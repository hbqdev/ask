import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import config from '../capacitor.config'

// Launch shows, in order: the native launch screen (LaunchScreen.storyboard:
// the Splash image over the LaunchBackground colour), the SplashScreen
// plugin's copy of that storyboard, the native container behind the web view
// (MainViewController), then the web LaunchView (bg-splash). Each must be the
// page background of the current appearance, or launch flashes:
//   light: oklch(0.99 0 0)        -> #fcfcfc
//   dark:  oklch(0.1 0.022 289)   -> #030309
const LIGHT = '#fcfcfc'
const DARK = '#030309'

const root = resolve(__dirname, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const assets = 'ios/App/App/Assets.xcassets'

/** The `fill` of the full-bleed background <rect> in a splash SVG. */
function svgBackground(path: string): string | undefined {
  return read(path).match(
    /<rect width="2732" height="2732" fill="(#[0-9a-f]{6})"/i
  )?.[1]
}

type ColourEntry = {
  appearances?: { appearance: string; value: string }[]
  color: { components: Record<'red' | 'green' | 'blue', string> }
}

function hex({ color: { components } }: ColourEntry): string {
  return (
    '#' +
    (['red', 'green', 'blue'] as const)
      .map(c => Number(components[c]).toString(16).padStart(2, '0'))
      .join('')
  )
}

const isDark = (entry: { appearances?: { value: string }[] }) =>
  entry.appearances?.some(a => a.value === 'dark') ?? false

describe('launch colours', () => {
  it('splash SVG sources use the page background of each appearance', () => {
    expect(svgBackground('assets/splash-light.svg')).toBe(LIGHT)
    expect(svgBackground('assets/splash.svg')).toBe(DARK)
  })

  it('the Splash image set has a light and a dark variant', () => {
    const { images } = JSON.parse(
      read(`${assets}/Splash.imageset/Contents.json`)
    ) as {
      images: {
        filename: string
        appearances?: { appearance: string; value: string }[]
      }[]
    }
    const dark = images.filter(isDark)
    const light = images.filter(i => !isDark(i))
    expect(dark.length).toBeGreaterThan(0)
    expect(light.length).toBeGreaterThan(0)
    for (const image of dark) {
      expect(image.appearances).toEqual([
        { appearance: 'luminosity', value: 'dark' }
      ])
      expect(image.filename).toMatch(/dark/)
    }
    for (const image of light) expect(image.filename).toMatch(/light/)
  })

  it('LaunchBackground is #fcfcfc in light and #030309 in dark', () => {
    const { colors } = JSON.parse(
      read(`${assets}/LaunchBackground.colorset/Contents.json`)
    ) as { colors: ColourEntry[] }
    expect(colors.filter(c => !isDark(c)).map(hex)).toEqual([LIGHT])
    expect(colors.filter(isDark).map(hex)).toEqual([DARK])
  })

  it('the launch storyboard paints LaunchBackground, not a fixed colour', () => {
    const storyboard = read('ios/App/App/Base.lproj/LaunchScreen.storyboard')
    expect(storyboard).toMatch(
      /<color key="backgroundColor" name="LaunchBackground"\/>/
    )
    expect(storyboard).toMatch(/<namedColor name="LaunchBackground">/)
  })

  it('the native container starts in the appearance colour', () => {
    const swift = read('ios/App/App/MainViewController.swift')
    expect(swift).toMatch(/userInterfaceStyle == \.dark/)
    expect(swift).toMatch(/0x03 \/ 255, green: 0x03 \/ 255, blue: 0x09 \/ 255/)
    expect(swift).toMatch(/0xFC \/ 255, green: 0xFC \/ 255, blue: 0xFC \/ 255/)
    expect(swift).not.toMatch(/0x0C \/ 255, green: 0x0A \/ 255/)
  })

  it('the web launch view uses the same colour per theme', () => {
    const css = read('src/styles.css')
    const splash = [...css.matchAll(/--splash:\s*(#[0-9a-f]{6})/gi)].map(
      m => m[1]
    )
    // :root (light), :root.dark, and the device-dark media query.
    expect(splash).toEqual([LIGHT, DARK, DARK])
  })

  it('capacitor.config sets no fixed launch colour over the adaptive ones', () => {
    // Capacitor paints the web view, and the SplashScreen plugin the launch
    // storyboard's view, with a configured backgroundColor in BOTH
    // appearances; unset, they keep systemBackground and LaunchBackground.
    expect(config).not.toHaveProperty('backgroundColor')
    expect(config.ios).not.toHaveProperty('backgroundColor')
    expect(config.plugins?.SplashScreen).not.toHaveProperty('backgroundColor')
  })
})

describe('native navigation', () => {
  it('leaves WKWebView back/forward swipes off (the JS stack owns swipe-back)', () => {
    const swift = read('ios/App/App/MainViewController.swift')
    expect(swift).not.toMatch(/allowsBackForwardNavigationGestures\s*=\s*true/)
  })
})
