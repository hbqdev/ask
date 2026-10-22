import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import config from '../capacitor.config'

// Launch shows, in order: the native launch screen (LaunchScreen.storyboard:
// the 96-pt SplashMark centred on the LaunchBackground colour), the SplashScreen
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

// The launch mark is the web LaunchView's: OrbitMark at size-24 (96 pt),
// centred, so the hand-off from the native splash to the web view is still.
describe('the launch mark', () => {
  it('the launch screen centres a 96-pt SplashMark on LaunchBackground', () => {
    const storyboard = read('ios/App/App/Base.lproj/LaunchScreen.storyboard')
    const root = storyboard.match(
      /<view key="view"[^>]*id="([^"]+)"[^>]*>([\s\S]*?)\n {20}<\/view>/
    )
    expect(root).not.toBeNull()
    const [, rootId, body] = root!
    // The root view's own background (after its subviews).
    expect(body).toMatch(
      /<\/subviews>[\s\S]*<color key="backgroundColor" name="LaunchBackground"\/>/
    )
    const image = body.match(
      /<imageView [^>]*image="SplashMark"[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/imageView>/
    )
    expect(image).not.toBeNull()
    const [, imageId, imageBody] = image!
    // 96 x 96 on the image itself.
    expect(imageBody).toMatch(
      /<constraint firstAttribute="width" constant="96" id="[^"]+"\/>/
    )
    expect(imageBody).toMatch(
      /<constraint firstAttribute="height" constant="96" id="[^"]+"\/>/
    )
    // Centred on the root view's safe area: MainViewController pins the web
    // view to the safe area, so that is where the web LaunchView centres its
    // mark too.
    const safeArea = body.match(
      /<viewLayoutGuide key="safeArea" id="([^"]+)"\/>/
    )
    expect(safeArea).not.toBeNull()
    const guideId = safeArea![1]
    expect(rootId).not.toBe(imageId)
    const constraints = [...body.matchAll(/<constraint [^>]*\/>/g)].map(
      m => m[0]
    )
    for (const axis of ['centerX', 'centerY']) {
      expect(constraints).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `firstItem="${imageId}" firstAttribute="${axis}" secondItem="${guideId}" secondAttribute="${axis}"`
          )
        )
      )
    }
    expect(storyboard).toMatch(
      /<image name="SplashMark" width="96" height="96"\/>/
    )
    expect(storyboard).not.toMatch(/image="Splash"/)
    expect(storyboard).not.toMatch(/<image name="Splash"/)
  })

  it('SplashMark is the in-app mark', () => {
    const svg = read('assets/splash-mark.svg')
    expect(svg).toMatch(/viewBox="20 24 60 54"/)
    const circles = [...svg.matchAll(/<circle ([^>]*)\/>/g)].map(m => m[1])
    expect(circles).toEqual([
      'cx="39" cy="43" r="17" fill="#3694f2" ',
      'cx="66" cy="39" r="12" fill="#944fee" ',
      'cx="53" cy="67" r="9" fill="#f4882a" '
    ])
    // The same geometry as the web mark.
    const mark = read('src/core/ui/OrbitMark.tsx')
    expect(mark).toContain('viewBox="20 24 60 54"')
    for (const c of circles) {
      expect(mark).toContain(c.replace(/ fill="[^"]+" $/, ''))
    }
    expect(svg).not.toMatch(/<rect/)
  })

  it('SplashMark ships @2x and @3x', () => {
    const set = `${assets}/SplashMark.imageset`
    const { images } = JSON.parse(read(`${set}/Contents.json`)) as {
      images: { filename?: string; idiom: string; scale: string }[]
    }
    const files = images.filter(i => i.filename)
    expect(files.map(i => [i.scale, i.filename])).toEqual([
      ['2x', 'splash-mark@2x.png'],
      ['3x', 'splash-mark@3x.png']
    ])
    for (const { filename } of files) {
      expect(existsSync(resolve(root, set, filename!))).toBe(true)
    }
    expect(existsSync(resolve(root, `${assets}/Splash.imageset`))).toBe(false)
  })
})

describe('native navigation', () => {
  it('leaves WKWebView back/forward swipes off (the JS stack owns swipe-back)', () => {
    const swift = read('ios/App/App/MainViewController.swift')
    expect(swift).not.toMatch(/allowsBackForwardNavigationGestures\s*=\s*true/)
  })
})
