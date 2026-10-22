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

/**
 * A PNG's size and whether it has alpha: from its IHDR (width and height
 * big-endian at bytes 16 and 20; colour types 4 and 6 carry alpha).
 */
function pngInfo(path: string) {
  const png = readFileSync(resolve(root, path))
  expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR')
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    alpha: png[25] === 4 || png[25] === 6
  }
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
    // Parsed, not matched as text: Xcode may re-save it indented otherwise.
    const doc = new DOMParser().parseFromString(storyboard, 'application/xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    const kids = (el: Element, tag: string) =>
      [...el.children].filter(c => c.tagName === tag)
    const rootView = doc.querySelector('viewController > view[key="view"]')
    expect(rootView).not.toBeNull()
    // The root view's own background.
    expect(
      kids(rootView!, 'color').map(c => [
        c.getAttribute('key'),
        c.getAttribute('name')
      ])
    ).toEqual([['backgroundColor', 'LaunchBackground']])
    const images = kids(rootView!, 'subviews').flatMap(v =>
      kids(v, 'imageView')
    )
    expect(images.map(i => i.getAttribute('image'))).toEqual(['SplashMark'])
    const image = images[0]
    const constraintsOf = (el: Element) =>
      kids(el, 'constraints').flatMap(c => kids(c, 'constraint'))
    const attrs = (c: Element) =>
      Object.fromEntries(
        ['firstItem', 'firstAttribute', 'secondItem', 'secondAttribute', 'constant']
          .filter(a => c.hasAttribute(a))
          .map(a => [a, c.getAttribute(a)])
      )
    // 96 x 96 on the image itself.
    expect(constraintsOf(image).map(attrs)).toEqual([
      { firstAttribute: 'width', constant: '96' },
      { firstAttribute: 'height', constant: '96' }
    ])
    // Centred on the root view's safe area: the web LaunchView is padded by
    // the safe area on all four sides (.app-root and .safe-bottom), so that is
    // where it centres its mark too, and so does the SplashScreen plugin's
    // copy of this storyboard, now that it covers the whole screen.
    const safeArea = kids(rootView!, 'viewLayoutGuide').find(
      g => g.getAttribute('key') === 'safeArea'
    )
    expect(safeArea).toBeDefined()
    const [imageId, guideId] = [image.id, safeArea!.id]
    expect(rootView!.id).not.toBe(imageId)
    expect(constraintsOf(rootView!).map(attrs)).toEqual(
      ['centerX', 'centerY'].map(axis => ({
        firstItem: imageId,
        firstAttribute: axis,
        secondItem: guideId,
        secondAttribute: axis
      }))
    )
    const resources = [...doc.querySelectorAll('resources > image')].map(i => [
      i.getAttribute('name'),
      i.getAttribute('width'),
      i.getAttribute('height')
    ])
    expect(resources).toEqual([['SplashMark', '96', '96']])
    expect(doc.querySelector('[image="Splash"]')).toBeNull()
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
    // 96 pt at each scale, the mark on transparent (the colour set shows
    // through).
    const sizes: Record<string, number> = { '2x': 192, '3x': 288 }
    for (const { filename, scale } of files) {
      expect(existsSync(resolve(root, set, filename!))).toBe(true)
      expect(pngInfo(`${set}/${filename}`)).toEqual({
        width: sizes[scale],
        height: sizes[scale],
        alpha: true
      })
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
